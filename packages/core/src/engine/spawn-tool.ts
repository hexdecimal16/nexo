import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { toErrorPayload } from "@nexo/telemetry";
import { Type } from "typebox";
import { EffortSchema } from "../config/schema.ts";
import { RunBudget } from "../cost/budget.ts";
import { executeRun, registerExtraTools, type RunToolContext } from "./run.ts";
import { runTaskGraph, type SpawnTask, type TaskOutcome, validateTaskGraph } from "./task-graph.ts";

const SpawnTaskSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Unique task id within this spawn call" }),
	instruction: Type.String({ minLength: 1, description: "Self-contained instruction for the subagent" }),
	skill: Type.Optional(Type.String({ description: "Skill to run the task with" })),
	model: Type.Optional(Type.String({ description: '"s1" (fast, cheap), "s2" (strong) or "provider/model-id"' })),
	effort: Type.Optional(EffortSchema),
	budgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task ids whose outputs this task needs" })),
	mode: Type.Optional(
		Type.Union([Type.Literal("explore"), Type.Literal("work")], {
			description: '"explore": read-only research (read, web_fetch, load_skill) that returns a short summary and keeps the parent context small; "work" (default): full tools. Run write-capable tasks one at a time.',
		}),
	),
});

const SpawnParams = Type.Object({ tasks: Type.Array(SpawnTaskSchema, { minItems: 1 }) });

function withDependencyOutputs(instruction: string, outputs: Record<string, string>): string {
	const entries = Object.entries(outputs);
	if (entries.length === 0) return instruction;
	return `${instruction}\n\nResults of tasks this depends on:\n${entries.map(([id, out]) => `[${id}]\n${out}`).join("\n\n")}`;
}

/** Validates and runs one spawn call's task graph and returns the tool result. */
async function runSpawn(
	ctx: RunToolContext,
	toolCallId: string,
	tasks: SpawnTask[],
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<TaskOutcome[]>> {
	const { env, budget, recorder } = ctx;
	const { config } = env.deps;
	validateTaskGraph(tasks);
	const spawnSpanId = ctx.toolSpanId(toolCallId);
	// Snapshot before any reservation: reservations shrink the remaining fraction, and the low-budget clamp must not
	// apply to whichever task happens to be reserved last.
	const parentRemainingFraction = budget.remainingFraction();
	const outcomes = await runTaskGraph(tasks, {
		maxParallel: config.spawn.maxParallelSubagents,
		isExclusive: (task) =>
			ctx.sharedWorkspace !== null && task.skill !== undefined && env.deps.skills.skills.get(task.skill)?.meta.parallelSafe === false,
		reserve: (task, pendingCount) => {
			const want = task.budgetUsd ?? budget.remainingUsd() / Math.max(1, pendingCount);
			if (want <= 1e-9) return null;
			return budget.tryReserve(want) ? want : null;
		},
		release: (reserved, outcome) => {
			budget.settleReservation(reserved, outcome.costUsd);
		},
		runTask: async (task, input) => {
			if (signal?.aborted) {
				// The parent was aborted while this task waited: report it without creating a child run.
				return { trajectoryId: null, status: "aborted", output: "", costUsd: 0, startedAt: null, endedAt: null };
			}
			const subSpan = recorder.start({ kind: "subagent", name: task.id, parentSpanId: spawnSpanId, queuedMs: input.queuedMs, attrs: { task, budgetUsd: input.budgetUsd } });
			const startedAt = env.now().toISOString();
			const runChild = (childBudgetUsd: number) =>
				executeRun(env, {
				request: {
					instruction: task.mode === "explore" ? `${withDependencyOutputs(task.instruction, input.dependencyOutputs)}\n\nYou are an explorer: you cannot change anything. Finish with a summary of at most 300 words: findings, source paths or URLs, and what you could not verify.` : withDependencyOutputs(task.instruction, input.dependencyOutputs),
					...(task.mode === "explore" ? { exploreOnly: true } : {}),
					skill: task.skill,
					model: task.model,
					effort: task.effort,
				},
				budget: new RunBudget(childBudgetUsd),
				signal,
				parent: {
					runId: ctx.runId,
					rootRunId: ctx.rootRunId,
					runDir: ctx.runDir,
					spanId: subSpan,
					taskId: task.id,
					depth: ctx.depth + 1,
					leases: ctx.leases,
					sharedWorkspace: ctx.sharedWorkspace,
					changeTracker: ctx.changeTracker,
					parentRemainingFraction,
					sessionId: ctx.sessionId,
					optimRunId: ctx.optimRunId,
					rolloutCandidate: ctx.rolloutCandidate,
					approvals: ctx.approvals,
				},
			});
			let result: Awaited<ReturnType<typeof runChild>>;
			let priorCostUsd = 0;
			try {
				result = await runChild(input.budgetUsd);
				// A retryable provider failure (e.g. a stalled CLI) gets one more attempt with whatever is left of the
				// task's reservation; the first attempt's spend still counts.
				const remainingUsd = input.budgetUsd - result.costUsd;
				if (result.status === "failed" && result.error?.retryable && !signal?.aborted && remainingUsd > 1e-9) {
					ctx.addChildCost(result.costUsd, result.costUnknown, result.approvalCostUsd);
					priorCostUsd = result.costUsd;
					env.deps.logger.warn("retrying subagent after retryable failure", { run_id: ctx.runId, task_id: task.id, error: result.error });
					result = await runChild(remainingUsd);
				}
			} catch (caught) {
				// Always close the span, otherwise it stays 'running' forever.
				try {
					recorder.finish(subSpan, { status: "error", attrs: { error: toErrorPayload(caught) } });
				} catch (finishError) {
					env.deps.logger.error("finishing subagent span failed", { run_id: ctx.runId, task_id: task.id, error: finishError });
				}
				throw caught;
			}
			ctx.addChildCost(result.costUsd, result.costUnknown, result.approvalCostUsd);
			try {
				recorder.finish(subSpan, {
					status: result.status === "succeeded" ? "ok" : "error",
					attrs: { trajectoryId: result.trajectoryId, status: result.status, childCostUsd: result.costUsd, error: result.error },
				});
			} catch (caught) {
				// The child's result stands even if its span cannot be written: its cost must still settle against the budget.
				env.deps.logger.error("finishing subagent span failed", { run_id: ctx.runId, task_id: task.id, error: caught });
			}
			return {
				trajectoryId: result.trajectoryId,
				status: result.status,
				output: result.output,
				costUsd: priorCostUsd + result.costUsd,
				startedAt,
				endedAt: env.now().toISOString(),
				...(result.error ? { error: result.error } : {}),
			};
		},
	});
	ctx.recordTaskGraph({ spawnSpanId, planned: tasks, executed: outcomes });
	const summary = outcomes.map((o) => ({
		id: o.id,
		trajectoryId: o.trajectoryId,
		status: o.status,
		output: o.output,
		costUsd: Number(o.costUsd.toFixed(6)),
		...(o.error ? { error: o.error } : {}),
	}));
	return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], details: outcomes };
}

function createSpawnTool(ctx: RunToolContext): AgentTool<typeof SpawnParams, TaskOutcome[]> {
	return {
		name: "spawn",
		label: "Spawn subagents",
		description:
			"Run tasks as parallel subagents. Independent tasks run at the same time; dependsOn orders tasks. Returns each task's status and output.",
		parameters: SpawnParams,
		execute: (toolCallId, params, signal) => runSpawn(ctx, toolCallId, params.tasks as SpawnTask[], signal),
	};
}

// Registered through run.ts's extra-tool registry instead of imported by run.ts, which would create a
// run.ts <-> spawn-tool.ts import cycle. core's index.ts imports this module for its side effect.
registerExtraTools((ctx) => (ctx.depth < ctx.env.deps.config.spawn.maxDepth ? [createSpawnTool(ctx)] : []));
