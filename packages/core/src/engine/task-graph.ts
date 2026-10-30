import type { Effort } from "@nexo/router";
import type { RunStatus } from "@nexo/store";
import { type ErrorPayload, NexoError, toErrorPayload } from "@nexo/telemetry";

export interface SpawnTask {
	id: string;
	instruction: string;
	skill?: string;
	model?: string;
	effort?: Effort;
	budgetUsd?: number;
	dependsOn?: string[];
	/** "explore" gives the subagent read-only tools and asks for a short summary; omitted or "work" gives it the full toolset. */
	mode?: "explore" | "work";
}

export type TaskStatus = RunStatus | "skipped";

export interface TaskOutcome {
	id: string;
	trajectoryId: string | null;
	status: TaskStatus;
	output: string;
	costUsd: number;
	error?: ErrorPayload;
	queuedMs: number;
	budgetUsd: number;
	startedAt: string | null;
	endedAt: string | null;
}

export type TaskRunResult = Omit<TaskOutcome, "id" | "queuedMs" | "budgetUsd">;

export interface ScheduleOptions {
	maxParallel: number;
	/** Reserve budget for a task; return the reserved USD, or null when it cannot be reserved right now. A throw fails only that task. */
	reserve: (task: SpawnTask, pendingCount: number) => number | null;
	/** Settle a finished task's reservation. A throw marks only that task as failed. */
	release: (reservedUsd: number, outcome: TaskOutcome) => void;
	runTask: (task: SpawnTask, input: { budgetUsd: number; dependencyOutputs: Record<string, string>; queuedMs: number }) => Promise<TaskRunResult>;
	isExclusive?: (task: SpawnTask) => boolean;
	now?: () => number;
}

export function validateTaskGraph(tasks: readonly SpawnTask[]): void {
	if (tasks.length === 0) throw new NexoError({ code: "TASK_GRAPH_INVALID", message: "spawn needs at least one task" });
	const ids = new Set<string>();
	for (const task of tasks) {
		if (ids.has(task.id)) throw new NexoError({ code: "TASK_GRAPH_INVALID", message: `Duplicate task id "${task.id}"` });
		ids.add(task.id);
	}
	for (const task of tasks) {
		for (const dep of task.dependsOn ?? []) {
			if (!ids.has(dep)) throw new NexoError({ code: "TASK_GRAPH_INVALID", message: `Task "${task.id}" depends on unknown task "${dep}"` });
		}
	}
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const state = new Map<string, "visiting" | "done">();
	const visit = (id: string, path: string[]): void => {
		if (state.get(id) === "done") return;
		if (state.get(id) === "visiting") {
			const cycle = [...path.slice(path.indexOf(id)), id];
			throw new NexoError({
				code: "TASK_GRAPH_CYCLE",
				message: `Task dependencies form a cycle: ${cycle.join(" → ")}`,
				hint: "Remove one dependsOn edge so tasks form a DAG",
				context: { cycle },
			});
		}
		state.set(id, "visiting");
		for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...path, id]);
		state.set(id, "done");
	};
	for (const task of tasks) visit(task.id, []);
}

/** Runs a validated task DAG: ready tasks start as concurrency and budget allow; failures never cancel siblings. */
export async function runTaskGraph(tasks: readonly SpawnTask[], opts: ScheduleOptions): Promise<TaskOutcome[]> {
	validateTaskGraph(tasks);
	const now = opts.now ?? Date.now;
	const outcomes = new Map<string, TaskOutcome>();
	const running = new Map<string, { promise: Promise<void>; exclusive: boolean }>();
	const readyAt = new Map<string, number>();
	const start = now();
	for (const task of tasks) if (!task.dependsOn?.length) readyAt.set(task.id, start);

	const pending = () => tasks.filter((task) => !outcomes.has(task.id) && !running.has(task.id));

	while (outcomes.size < tasks.length) {
		for (const task of pending()) {
			const failedDep = (task.dependsOn ?? []).find((d) => outcomes.has(d) && outcomes.get(d)?.status !== "succeeded");
			if (failedDep) {
				outcomes.set(task.id, {
					id: task.id,
					trajectoryId: null,
					status: "skipped",
					output: `Skipped because dependency "${failedDep}" ended as ${outcomes.get(failedDep)?.status}`,
					costUsd: 0,
					queuedMs: 0,
					budgetUsd: 0,
					startedAt: null,
					endedAt: null,
				});
				continue;
			}
			if (!readyAt.has(task.id) && (task.dependsOn ?? []).every((d) => outcomes.get(d)?.status === "succeeded")) readyAt.set(task.id, now());
		}

		const ready = pending().filter((task) => readyAt.has(task.id));
		let blockedByBudget: SpawnTask[] = [];
		for (const task of ready) {
			if (running.size >= opts.maxParallel) break;
			const exclusive = opts.isExclusive?.(task) ?? false;
			if ([...running.values()].some((r) => r.exclusive)) break;
			if (exclusive && running.size > 0) break;
			let reserved: number | null;
			try {
				reserved = opts.reserve(task, pending().length);
			} catch (error) {
				outcomes.set(task.id, {
					id: task.id,
					trajectoryId: null,
					status: "failed",
					output: "",
					costUsd: 0,
					queuedMs: now() - (readyAt.get(task.id) ?? now()),
					budgetUsd: 0,
					startedAt: null,
					endedAt: null,
					error: toErrorPayload(error),
				});
				continue;
			}
			if (reserved === null) {
				blockedByBudget = [task];
				break;
			}
			const reservedUsd = reserved;
			const queuedMs = now() - (readyAt.get(task.id) ?? now());
			const dependencyOutputs: Record<string, string> = {};
			for (const dep of task.dependsOn ?? []) dependencyOutputs[dep] = outcomes.get(dep)?.output ?? "";
			const promise = opts
				.runTask(task, { budgetUsd: reservedUsd, dependencyOutputs, queuedMs })
				.catch((error): TaskRunResult => ({ trajectoryId: null, status: "failed", output: "", costUsd: 0, error: toErrorPayload(error), startedAt: null, endedAt: null }))
				.then((result) => {
					let outcome: TaskOutcome = { id: task.id, queuedMs, budgetUsd: reservedUsd, ...result };
					try {
						opts.release(reservedUsd, outcome);
					} catch (error) {
						outcome = { ...outcome, status: "failed", error: toErrorPayload(error) };
					}
					outcomes.set(task.id, outcome);
					running.delete(task.id);
				});
			running.set(task.id, { promise, exclusive });
			if (exclusive) break;
		}

		if (running.size > 0) {
			await Promise.race([...running.values()].map((r) => r.promise));
			continue;
		}
		for (const task of blockedByBudget) {
			outcomes.set(task.id, {
				id: task.id,
				trajectoryId: null,
				status: "budget_exceeded",
				output: "",
				costUsd: 0,
				queuedMs: now() - (readyAt.get(task.id) ?? now()),
				budgetUsd: 0,
				startedAt: null,
				endedAt: null,
				error: new NexoError({
					code: "BUDGET_EXCEEDED",
					message: `Not enough remaining budget to start task "${task.id}"`,
					hint: "Give the task a smaller budgetUsd or raise the parent's budget",
				}).toPayload(),
			});
		}
		if (blockedByBudget.length === 0 && pending().length > 0 && ready.length === 0) break;
	}
	return tasks.map((task) => outcomes.get(task.id) as TaskOutcome);
}
