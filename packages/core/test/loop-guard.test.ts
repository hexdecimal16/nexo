import { readdirSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { listSpans } from "@nexo/store";
import { createEngine, type EngineEvent } from "../src/index.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../src/engine/prompts.ts";
import { DEFAULT_CONFIG } from "../src/config/schema.ts";
import { lastToolResultText, makeEnv, useDispatcher } from "./helpers.ts";

const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })]);

describe("loop guard defaults", () => {
	it("ships a cap, a repeat limit and a verification line in the prompt", () => {
		expect(DEFAULT_CONFIG.loop).toEqual({ maxToolCalls: 200, repeatLimit: 3 });
		expect(DEFAULT_SYSTEM_PROMPT).toContain("check the result against the instruction");
	});
});

describe("repeat limit", () => {
	it("blocks the call after repeatLimit identical calls, tells the model why and emits loop_guard", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, loop: { repeatLimit: 2, maxToolCalls: 0 } } });
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		let seen = "";
		env.faux.setResponses([
			bash("echo same"),
			bash("echo same"),
			bash("echo same"),
			async (ctx) => {
				seen = lastToolResultText(ctx);
				return fauxAssistantMessage("changed approach");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "Loop" });
		expect(result.status).toBe("succeeded");
		expect(seen).toContain("LOOP_REPEAT");
		expect(seen).toContain("loop.repeatLimit 2");
		expect(events.filter((e) => e.type === "loop_guard")).toEqual([expect.objectContaining({ kind: "repeat", toolName: "bash", count: 3, limit: 2 })]);
	});

	it("does not block different arguments or the same call after another call in between", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, loop: { repeatLimit: 1, maxToolCalls: 0 } } });
		let seen = "";
		env.faux.setResponses([
			bash("echo a"),
			bash("echo b"),
			bash("echo a"),
			async (ctx) => {
				seen = lastToolResultText(ctx);
				return fauxAssistantMessage("done");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "Vary" });
		expect(result.status).toBe("succeeded");
		expect(seen).not.toContain("LOOP_");
		expect(seen).toContain("exit code: 0");
	});

	it("is off when repeatLimit is 0", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, loop: { repeatLimit: 0, maxToolCalls: 0 } } });
		let seen = "";
		env.faux.setResponses([
			bash("echo same"),
			bash("echo same"),
			bash("echo same"),
			bash("echo same"),
			async (ctx) => {
				seen = lastToolResultText(ctx);
				return fauxAssistantMessage("done");
			},
		]);
		await createEngine(env.deps).run({ instruction: "Loop" });
		expect(seen).not.toContain("LOOP_");
	});
});

describe("max tool calls", () => {
	it("asks the agent to report once the cap is passed and keeps its answer", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, loop: { repeatLimit: 0, maxToolCalls: 2 } } });
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		let seen = "";
		env.faux.setResponses([
			bash("echo 1"),
			bash("echo 2"),
			bash("echo 3"),
			async (ctx) => {
				seen = lastToolResultText(ctx);
				return fauxAssistantMessage("report: ran 1 and 2, 3 remains");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "Many" });
		expect(result.status).toBe("succeeded");
		expect(result.output).toContain("report: ran 1 and 2");
		expect(seen).toContain("LOOP_LIMIT");
		expect(seen).toContain("Do not call more tools");
		expect(events.filter((e) => e.type === "loop_guard")).toEqual([expect.objectContaining({ kind: "max_tool_calls", limit: 2 })]);
	});

	it("fails with LOOP_LIMIT when the agent keeps calling tools after the warning", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, loop: { repeatLimit: 0, maxToolCalls: 2 } } });
		env.faux.setResponses([bash("echo 1"), bash("echo 2"), bash("echo 3"), bash("echo 4"), bash("echo 5"), fauxAssistantMessage("never")]);
		const result = await createEngine(env.deps).run({ instruction: "Many" });
		expect(result.status).toBe("failed");
		expect(result.error?.code).toBe("LOOP_LIMIT");
		expect(result.error?.hint).toContain("loop.maxToolCalls");
		expect(result.output).not.toContain("never");
		const llm = listSpans(env.deps.db, result.trajectoryId as string).filter((s) => s.kind === "llm_call").length;
		expect(llm).toBe(4);
	});

	it("has no cap when maxToolCalls is 0", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, loop: { repeatLimit: 0, maxToolCalls: 0 } } });
		env.faux.setResponses([bash("echo 1"), bash("echo 2"), bash("echo 3"), bash("echo 4"), fauxAssistantMessage("all four")]);
		const result = await createEngine(env.deps).run({ instruction: "Many" });
		expect(result).toMatchObject({ status: "succeeded", output: "all four" });
	});
});

describe("explore mode", () => {
	it("gives the subagent read-only tools and a summary instruction", async () => {
		const env = makeEnv();
		let childSeen = "";
		let childInstruction = "";
		useDispatcher(env, {
			PARENT: [
				fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "scout", instruction: "CHILD look around", mode: "explore" }] })]),
				fauxAssistantMessage("parent done"),
			],
			CHILD: [
				async (ctx) => {
					childInstruction = JSON.stringify(ctx.messages);
					return fauxAssistantMessage([fauxToolCall("write", { path: "leak.txt", content: "x" })]);
				},
				async (ctx) => {
					childSeen = lastToolResultText(ctx);
					return fauxAssistantMessage("summary");
				},
			],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT" });
		expect(result.status).toBe("succeeded");
		expect(childInstruction).toContain("You are an explorer");
		expect(childInstruction).toContain("300 words");
		expect(childSeen).not.toContain("Wrote");
		const written = readdirSync(env.deps.paths.runs, { recursive: true }).map(String);
		expect(written.some((p) => p.endsWith("leak.txt"))).toBe(false);
	});

	it("leaves work-mode subagents with the write tool", async () => {
		const env = makeEnv();
		let childSeen = "";
		useDispatcher(env, {
			PARENT: [
				fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "w", instruction: "CHILD write it", mode: "work" }] })]),
				fauxAssistantMessage("parent done"),
			],
			CHILD: [
				fauxAssistantMessage([fauxToolCall("write", { path: "ok.txt", content: "x" })]),
				async (ctx) => {
					childSeen = lastToolResultText(ctx);
					return fauxAssistantMessage("summary");
				},
			],
		});
		await createEngine(env.deps).run({ instruction: "PARENT" });
		expect(childSeen).toContain("Wrote");
		const written = readdirSync(env.deps.paths.runs, { recursive: true }).map(String);
		expect(written.some((p) => p.endsWith("ok.txt"))).toBe(true);
	});
});
