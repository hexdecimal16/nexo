import { describe, expect, it } from "vitest";
import type { NexoError } from "@nexo/telemetry";
import { runTaskGraph, type ScheduleOptions, type SpawnTask, validateTaskGraph } from "../src/engine/task-graph.ts";

function opts(overrides: Partial<ScheduleOptions> = {}): ScheduleOptions {
	return {
		maxParallel: 4,
		reserve: () => 0.1,
		release: () => {},
		runTask: async (task) => ({ trajectoryId: `t-${task.id}`, status: "succeeded", output: `out-${task.id}`, costUsd: 0.01, startedAt: "s", endedAt: "e" }),
		...overrides,
	};
}

const t = (id: string, dependsOn?: string[]): SpawnTask => ({ id, instruction: `do ${id}`, ...(dependsOn ? { dependsOn } : {}) });

describe("validateTaskGraph", () => {
	it("rejects cycles with the cycle path", () => {
		try {
			validateTaskGraph([t("a", ["b"]), t("b", ["c"]), t("c", ["a"])]);
			expect.unreachable();
		} catch (err) {
			expect((err as NexoError).code).toBe("TASK_GRAPH_CYCLE");
			expect((err as NexoError).message).toContain("a → b → c → a");
		}
	});

	it.each([
		["empty", []],
		["duplicate ids", [t("a"), t("a")]],
		["unknown dependency", [t("a", ["zzz"])]],
	])("rejects %s with TASK_GRAPH_INVALID", (_label, tasks) => {
		try {
			validateTaskGraph(tasks as SpawnTask[]);
			expect.unreachable();
		} catch (err) {
			expect((err as NexoError).code).toBe("TASK_GRAPH_INVALID");
		}
	});
});

describe("runTaskGraph", () => {
	it("runs independent tasks concurrently up to maxParallel", async () => {
		let active = 0;
		let max = 0;
		const outcomes = await runTaskGraph(
			[t("a"), t("b"), t("c")],
			opts({
				maxParallel: 2,
				runTask: async (task) => {
					active++;
					max = Math.max(max, active);
					await new Promise((r) => setTimeout(r, 20));
					active--;
					return { trajectoryId: task.id, status: "succeeded", output: task.id, costUsd: 0, startedAt: null, endedAt: null };
				},
			}),
		);
		expect(max).toBe(2);
		expect(outcomes.map((o) => o.id)).toEqual(["a", "b", "c"]);
	});

	it("orders dependent tasks and passes dependency outputs", async () => {
		const seen: Record<string, Record<string, string>> = {};
		const order: string[] = [];
		await runTaskGraph(
			[t("c", ["a", "b"]), t("a"), t("b")],
			opts({
				runTask: async (task, input) => {
					order.push(task.id);
					seen[task.id] = input.dependencyOutputs;
					return { trajectoryId: task.id, status: "succeeded", output: `out-${task.id}`, costUsd: 0, startedAt: null, endedAt: null };
				},
			}),
		);
		expect(order.at(-1)).toBe("c");
		expect(seen.c).toEqual({ a: "out-a", b: "out-b" });
	});

	it("skips dependents of failed tasks and isolates sibling failures", async () => {
		const outcomes = await runTaskGraph(
			[t("bad"), t("ok"), t("child", ["bad"])],
			opts({
				runTask: async (task) => {
					if (task.id === "bad") throw new Error("boom");
					return { trajectoryId: task.id, status: "succeeded", output: "fine", costUsd: 0, startedAt: null, endedAt: null };
				},
			}),
		);
		const byId = Object.fromEntries(outcomes.map((o) => [o.id, o]));
		expect(byId.bad?.status).toBe("failed");
		expect(byId.bad?.error?.message).toBe("boom");
		expect(byId.ok?.status).toBe("succeeded");
		expect(byId.child?.status).toBe("skipped");
		expect(byId.child?.output).toContain('dependency "bad"');
	});

	it("waits for budget released by running tasks, then fails tasks that can never be reserved", async () => {
		let available = 1;
		const outcomes = await runTaskGraph(
			[t("a"), t("b"), { ...t("huge"), budgetUsd: 5 }],
			opts({
				maxParallel: 3,
				reserve: (task) => {
					const want = task.budgetUsd ?? 1;
					if (want > available) return null;
					available -= want;
					return want;
				},
				release: (reserved) => {
					available += reserved;
				},
			}),
		);
		const byId = Object.fromEntries(outcomes.map((o) => [o.id, o]));
		expect(byId.a?.status).toBe("succeeded");
		expect(byId.b?.status).toBe("succeeded");
		expect(byId.huge?.status).toBe("budget_exceeded");
		expect(byId.huge?.error?.code).toBe("BUDGET_EXCEEDED");
	});

	it("runs exclusive tasks alone", async () => {
		let active = 0;
		let exclusiveSawOthers = false;
		await runTaskGraph(
			[t("a"), t("x"), t("b")],
			opts({
				isExclusive: (task) => task.id === "x",
				runTask: async (task) => {
					active++;
					if (task.id === "x" && active > 1) exclusiveSawOthers = true;
					await new Promise((r) => setTimeout(r, 10));
					if (task.id === "x" && active > 1) exclusiveSawOthers = true;
					active--;
					return { trajectoryId: task.id, status: "succeeded", output: "", costUsd: 0, startedAt: null, endedAt: null };
				},
			}),
		);
		expect(exclusiveSawOthers).toBe(false);
	});

	it("measures queue time from readiness to start", async () => {
		let clock = 0;
		const outcomes = await runTaskGraph(
			[t("a"), t("b")],
			opts({
				maxParallel: 1,
				now: () => clock,
				runTask: async (task) => {
					clock += 100;
					return { trajectoryId: task.id, status: "succeeded", output: "", costUsd: 0, startedAt: null, endedAt: null };
				},
			}),
		);
		expect(outcomes[0]?.queuedMs).toBe(0);
		expect(outcomes[1]?.queuedMs).toBe(100);
	});

	it("fails only the affected task when reserve or release throws", async () => {
		const outcomes = await runTaskGraph(
			[t("badreserve"), t("badrelease"), t("ok"), t("child", ["badreserve"])],
			opts({
				reserve: (task) => {
					if (task.id === "badreserve") throw new Error("invalid amount");
					return 0.1;
				},
				release: (_reserved, outcome) => {
					if (outcome.id === "badrelease") throw new Error("settle failed");
				},
			}),
		);
		const byId = Object.fromEntries(outcomes.map((o) => [o.id, o]));
		expect(byId.badreserve?.status).toBe("failed");
		expect(byId.badreserve?.error?.message).toBe("invalid amount");
		expect(byId.badrelease?.status).toBe("failed");
		expect(byId.badrelease?.error?.message).toBe("settle failed");
		expect(byId.ok?.status).toBe("succeeded");
		expect(byId.child?.status).toBe("skipped");
	});
});
