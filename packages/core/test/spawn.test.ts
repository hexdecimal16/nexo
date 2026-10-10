import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonValue } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRun, listChildRuns, listSpans, readRunJson } from "@nexo/store";
import { Recorder } from "../src/engine/recorder.ts";
import { createEngine } from "../src/index.ts";
import { firstUserText, lastToolResultText, makeEnv, useDispatcher } from "./helpers.ts";

const spawnCall = (tasks: JsonValue[]) => fauxAssistantMessage([fauxToolCall("spawn", { tasks })]);

/** The USD the run has spent according to the last budget line the engine added to the transcript. */
function spentFromBudgetLine(ctx: Parameters<typeof firstUserText>[0]): number {
	const text = JSON.stringify(ctx.messages);
	const matches = [...text.matchAll(/Budget: \$([0-9.]+) of \$([0-9.]+) remaining/g)];
	const last = matches.at(-1);
	if (!last) throw new Error("no budget line in transcript");
	return Number(last[2]) - Number(last[1]);
}

describe("spawn", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs independent children in parallel, nests them on disk and in spans, and rolls up cost", async () => {
		const env = makeEnv();
		let active = 0;
		let maxActive = 0;
		const child = (name: string) => async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 40));
			active--;
			return fauxAssistantMessage(`${name} done`);
		};
		useDispatcher(env, {
			PARENT: [spawnCall([{ id: "a", instruction: "CHILD-A" }, { id: "b", instruction: "CHILD-B", model: "s2" }]), fauxAssistantMessage("All done.")],
			"CHILD-A": [child("A")],
			"CHILD-B": [child("B")],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT" });
		expect(result.status).toBe("succeeded");
		expect(maxActive).toBe(2);

		const children = listChildRuns(env.deps.db, result.trajectoryId as string);
		expect(children).toHaveLength(2);
		for (const c of children) {
			expect(c.rootRunId).toBe(result.trajectoryId);
			expect(existsSync(join(result.runDir as string, "subagents", c.id, "run.json"))).toBe(true);
		}
		const childB = children.find((c) => c.instruction === "CHILD-B");
		expect(childB?.modelFinal).toBe("faux/slow");
		const parentSpans = listSpans(env.deps.db, result.trajectoryId as string);
		const spawnSpan = parentSpans.find((s) => s.name === "spawn");
		const subSpans = parentSpans.filter((s) => s.kind === "subagent");
		expect(subSpans).toHaveLength(2);
		expect(subSpans.every((s) => s.parentSpanId === spawnSpan?.id)).toBe(true);
		const childCost = children.reduce((sum, c) => sum + c.costUsd, 0);
		const ownLlmCost = parentSpans.filter((s) => s.kind === "llm_call").reduce((sum, s) => sum + s.costUsd, 0);
		expect(ownLlmCost).toBeGreaterThan(0);
		expect(childCost).toBeGreaterThan(0);
		expect(getRun(env.deps.db, result.trajectoryId as string)?.costUsd).toBeCloseTo(ownLlmCost + childCost, 9);
		const graph = readRunJson(result.runDir as string).taskGraphs;
		expect(graph).toHaveLength(1);
		expect(graph[0]?.planned).toHaveLength(2);
	});

	it("isolates a child whose requested model is not allowed by its skill", async () => {
		const env = makeEnv({ skills: { lite: "---\nname: lite\ndescription: Lite\nmetadata:\n  nexo-model-allowed: s1\n---\nBe brief.\n" } });
		let toolResult = "";
		useDispatcher(env, {
			PARENT: [
				spawnCall([{ id: "bad", instruction: "CHILD-BAD", skill: "lite", model: "s2" }, { id: "ok", instruction: "CHILD-OK" }]),
				async (ctx) => {
					toolResult = lastToolResultText(ctx);
					return fauxAssistantMessage("handled");
				},
			],
			"CHILD-OK": [fauxAssistantMessage("ok done")],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT" });
		expect(result.status).toBe("succeeded");
		const outcomes = JSON.parse(toolResult) as { id: string; status: string; error?: { code: string } }[];
		expect(outcomes.find((o) => o.id === "bad")).toMatchObject({ status: "failed", error: { code: "MODEL_NOT_ALLOWED" } });
		expect(outcomes.find((o) => o.id === "ok")?.status).toBe("succeeded");
	});

	it("runs a spawned skill on the model its nexo-model pins", async () => {
		const env = makeEnv({ skills: { heavy: "---\nname: heavy\ndescription: Heavy\nmetadata:\n  nexo-model: s2\n---\nThink hard.\n" } });
		useDispatcher(env, {
			PARENT: [spawnCall([{ id: "h", instruction: "CHILD-HEAVY", skill: "heavy" }]), fauxAssistantMessage("done")],
			"CHILD-HEAVY": [fauxAssistantMessage("heavy done")],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT" });
		expect(result.status).toBe("succeeded");
		const [child] = listChildRuns(env.deps.db, result.trajectoryId as string);
		expect(child).toMatchObject({ skill: "heavy", modelFinal: "faux/slow", tierFinal: "s2" });
		const llm = listSpans(env.deps.db, child?.id as string).find((s) => s.kind === "llm_call");
		expect(llm?.modelSource).toBe("skill");
	});

	it("rejects dependency cycles as a tool error and lets the parent continue", async () => {
		const env = makeEnv();
		let toolResult = "";
		useDispatcher(env, {
			PARENT: [
				spawnCall([{ id: "a", instruction: "X", dependsOn: ["b"] }, { id: "b", instruction: "Y", dependsOn: ["a"] }]),
				async (ctx) => {
					toolResult = lastToolResultText(ctx);
					return fauxAssistantMessage("fixed plan");
				},
			],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT" });
		expect(result.status).toBe("succeeded");
		expect(toolResult).toContain("TASK_GRAPH_CYCLE");
	});

	it("supports nesting to depth 3 and withholds spawn at maxDepth", async () => {
		const env = makeEnv({ config: { spawn: { maxDepth: 3 } } });
		let depth3Result = "";
		useDispatcher(env, {
			"L0-ROOT": [spawnCall([{ id: "l1", instruction: "L1-NODE" }]), fauxAssistantMessage("root done")],
			"L1-NODE": [spawnCall([{ id: "l2", instruction: "L2-NODE" }]), fauxAssistantMessage("l1 done")],
			"L2-NODE": [spawnCall([{ id: "l3", instruction: "L3-NODE" }]), fauxAssistantMessage("l2 done")],
			"L3-NODE": [
				spawnCall([{ id: "l4", instruction: "L4-NODE" }]),
				async (ctx) => {
					depth3Result = lastToolResultText(ctx);
					return fauxAssistantMessage("l3 done");
				},
			],
		});
		const result = await createEngine(env.deps).run({ instruction: "L0-ROOT" });
		expect(result.status).toBe("succeeded");
		const l1 = listChildRuns(env.deps.db, result.trajectoryId as string)[0];
		const l2 = listChildRuns(env.deps.db, l1?.id as string)[0];
		const l3 = listChildRuns(env.deps.db, l2?.id as string)[0];
		expect(l3?.status).toBe("succeeded");
		expect(existsSync(join(result.runDir as string, "subagents", l1?.id as string, "subagents", l2?.id as string, "subagents", l3?.id as string))).toBe(true);
		expect(depth3Result.toLowerCase()).toContain("spawn");
		expect(listChildRuns(env.deps.db, l3?.id as string)).toHaveLength(0);
	});

	it("reports budget_exceeded for tasks whose reservation does not fit", async () => {
		const env = makeEnv({ config: { budgets: { perRunUsd: 0.05 } } });
		let toolResult = "";
		useDispatcher(env, {
			PARENT: [
				spawnCall([{ id: "huge", instruction: "CHILD-HUGE", budgetUsd: 10 }]),
				async (ctx) => {
					toolResult = lastToolResultText(ctx);
					return fauxAssistantMessage("ok");
				},
			],
		});
		await createEngine(env.deps).run({ instruction: "PARENT" });
		expect(JSON.parse(toolResult)[0]).toMatchObject({ id: "huge", status: "budget_exceeded" });
	});

	it("gives one of two children writing the same file in a shared workspace a WRITE_CONFLICT", async () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-shared-"));
		const env = makeEnv();
		let aWrote!: () => void;
		const aWroteP = new Promise<void>((r) => {
			aWrote = r;
		});
		let bTried!: () => void;
		const bTriedP = new Promise<void>((r) => {
			bTried = r;
		});
		let bToolResult = "";
		useDispatcher(env, {
			PARENT: [spawnCall([{ id: "a", instruction: "WRITER-A" }, { id: "b", instruction: "WRITER-B" }]), fauxAssistantMessage("done")],
			"WRITER-A": [
				fauxAssistantMessage([fauxToolCall("write", { path: "same.txt", content: "A" })]),
				async () => {
					aWrote();
					await bTriedP;
					return fauxAssistantMessage("A finished");
				},
			],
			"WRITER-B": [
				async () => {
					await aWroteP;
					return fauxAssistantMessage([fauxToolCall("write", { path: "same.txt", content: "B" })]);
				},
				async (ctx) => {
					bToolResult = lastToolResultText(ctx);
					bTried();
					return fauxAssistantMessage("B finished");
				},
			],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT", workspace: ws });
		expect(result.status).toBe("succeeded");
		expect(bToolResult).toMatch(/^WRITE_CONFLICT \(retryable\): .*another task/);
	});
	it("keeps a child's real result and cost when its subagent span cannot be finished", async () => {
		const env = makeEnv({ config: { models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "pricey" } } } });
		const finish = Recorder.prototype.finish;
		vi.spyOn(Recorder.prototype, "finish").mockImplementation(function (this: Recorder, id, patch) {
			if (patch.attrs && "childCostUsd" in patch.attrs) throw new Error("disk full");
			finish.call(this, id, patch);
		});
		let toolResult = "";
		let spentAfterSpawn = 0;
		useDispatcher(env, {
			PARENT: [
				spawnCall([{ id: "p", instruction: "CHILD-PRICEY", model: "s2" }]),
				async (ctx) => {
					toolResult = lastToolResultText(ctx);
					spentAfterSpawn = spentFromBudgetLine(ctx);
					return fauxAssistantMessage("done");
				},
			],
			"CHILD-PRICEY": [fauxAssistantMessage("x".repeat(4000))],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT", budgetUsd: 5 });
		expect(result.status).toBe("succeeded");
		const [child] = listChildRuns(env.deps.db, result.trajectoryId as string);
		expect(child?.status).toBe("succeeded");
		expect(child?.costUsd).toBeGreaterThan(0.5);
		const outcome = (JSON.parse(toolResult) as { status: string; costUsd: number }[])[0];
		expect(outcome).toMatchObject({ status: "succeeded" });
		expect(outcome?.costUsd).toBeCloseTo(child?.costUsd as number, 6);
		expect(spentAfterSpawn).toBeGreaterThanOrEqual((child?.costUsd as number) - 1e-4);
	});

	it("stops starting children once the parent is aborted mid-spawn", async () => {
		const env = makeEnv({ config: { spawn: { maxParallelSubagents: 1 } } });
		const ac = new AbortController();
		let callsAfterAbort = 0;
		const count = (step: () => Promise<ReturnType<typeof fauxAssistantMessage>>) => async () => {
			if (ac.signal.aborted) callsAfterAbort++;
			return step();
		};
		useDispatcher(env, {
			PARENT: [spawnCall([{ id: "a", instruction: "CHILD-A" }, { id: "b", instruction: "CHILD-B" }]), count(async () => fauxAssistantMessage("parent again"))],
			"CHILD-A": [
				async () => {
					ac.abort();
					await new Promise((r) => setTimeout(r, 30));
					return fauxAssistantMessage("late");
				},
				count(async () => fauxAssistantMessage("a again")),
			],
			"CHILD-B": [count(async () => fauxAssistantMessage("b ran"))],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT" }, ac.signal);
		expect(result.status).toBe("aborted");
		expect(callsAfterAbort).toBe(0);
		const children = listChildRuns(env.deps.db, result.trajectoryId as string);
		expect(children.map((c) => [c.instruction, c.status])).toEqual([["CHILD-A", "aborted"]]);
		expect(existsSync(join(result.runDir as string, "subagents"))).toBe(true);
		const subSpans = listSpans(env.deps.db, result.trajectoryId as string).filter((s) => s.kind === "subagent");
		expect(subSpans.map((s) => s.name)).toEqual(["a"]);
		const executed = readRunJson(result.runDir as string).taskGraphs[0]?.executed as { id: string; status: string; trajectoryId: string | null }[] | undefined;
		expect(executed?.map((o) => [o.id, o.status, o.trajectoryId === null])).toEqual([
			["a", "aborted", false],
			["b", "aborted", true],
		]);
	});

	it("frees a failed child's reservation so the next sibling reserves the full remaining budget", async () => {
		const env = makeEnv({
			config: { spawn: { maxParallelSubagents: 1 } },
			skills: { lite: "---\nname: lite\ndescription: Lite\nmetadata:\n  nexo-model-allowed: s1\n---\nBe brief.\n" },
		});
		useDispatcher(env, {
			PARENT: [spawnCall([{ id: "bad", instruction: "CHILD-BAD", skill: "lite", model: "s2" }, { id: "ok", instruction: "CHILD-OK" }]), fauxAssistantMessage("done")],
			"CHILD-OK": [fauxAssistantMessage("ok done")],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT", budgetUsd: 1 });
		expect(result.status).toBe("succeeded");
		const spans = listSpans(env.deps.db, result.trajectoryId as string);
		const firstLlmCost = spans.find((s) => s.kind === "llm_call")?.costUsd ?? 0;
		const sub = (name: string) => spans.find((s) => s.kind === "subagent" && s.name === name);
		expect(sub("bad")?.attrs.budgetUsd).toBeCloseTo((1 - firstLlmCost) / 2, 9);
		expect(sub("bad")?.attrs.status).toBe("failed");
		expect(sub("ok")?.attrs.budgetUsd).toBeCloseTo(1 - firstLlmCost, 9);
	});

	it("passes a dependency's output into the dependent task's instruction", async () => {
		const env = makeEnv();
		let dependentPrompt = "";
		useDispatcher(env, {
			PARENT: [spawnCall([{ id: "first", instruction: "STEP-ONE" }, { id: "second", instruction: "STEP-TWO", dependsOn: ["first"] }]), fauxAssistantMessage("done")],
			"STEP-ONE": [fauxAssistantMessage("alpha-result-42")],
			"STEP-TWO": [
				async (ctx) => {
					dependentPrompt = firstUserText(ctx);
					return fauxAssistantMessage("used it");
				},
			],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT" });
		expect(result.status).toBe("succeeded");
		expect(dependentPrompt).toContain("STEP-TWO");
		expect(dependentPrompt).toContain("Results of tasks this depends on:\n[first]\nalpha-result-42");
	});

	it("labels a subagent's approval prompt with its run id", async () => {
		const asked: string[] = [];
		const env = makeEnv({
			prompter: {
				interactive: true,
				confirm: async (q) => {
					asked.push(q);
					return false;
				},
			},
		});
		useDispatcher(env, {
			PARENT: [fauxAssistantMessage([fauxToolCall("bash", { command: "echo parent" })]), spawnCall([{ id: "c", instruction: "ASKER" }]), fauxAssistantMessage("done")],
			ASKER: [fauxAssistantMessage([fauxToolCall("bash", { command: "echo child" })]), fauxAssistantMessage("declined")],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT" });
		const [child] = listChildRuns(env.deps.db, result.trajectoryId as string);
		expect(asked).toEqual(["Allow bash: echo parent?", `[subagent ${child?.id.slice(-6)}] Allow bash: echo child?`]);
	});

	it("lets a child fill a file its parent scaffolded in a shared workspace", async () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-shared-"));
		const env = makeEnv();
		let childToolResult = "";
		useDispatcher(env, {
			PARENT: [
				fauxAssistantMessage([fauxToolCall("write", { path: "notes.md", content: "# Notes\nTODO\n" })]),
				spawnCall([{ id: "fill", instruction: "FILLER" }]),
				fauxAssistantMessage("done"),
			],
			FILLER: [
				fauxAssistantMessage([fauxToolCall("edit", { path: "notes.md", oldText: "TODO", newText: "filled" })]),
				async (ctx) => {
					childToolResult = lastToolResultText(ctx);
					return fauxAssistantMessage("filled");
				},
			],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT", workspace: ws });
		expect(result.status).toBe("succeeded");
		expect(childToolResult).toBe("Edited notes.md");
		expect(readFileSync(join(ws, "notes.md"), "utf8")).toBe("# Notes\nfilled\n");
	});
});
