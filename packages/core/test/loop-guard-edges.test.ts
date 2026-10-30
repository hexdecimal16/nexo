import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createEngine, type EngineEvent } from "../src/index.ts";
import { makeEnv, useDispatcher } from "./helpers.ts";

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("loop guard edge cases", () => {
	it("blocks identical calls made in parallel in one model reply", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, loop: { repeatLimit: 2, maxToolCalls: 0 } } });
		let transcript = "";
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo p" }), fauxToolCall("bash", { command: "echo p" }), fauxToolCall("bash", { command: "echo p" })]),
			async (ctx) => {
				transcript = JSON.stringify(ctx.messages);
				return fauxAssistantMessage("done");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "Parallel" });
		expect(result.status).toBe("succeeded");
		expect(count(transcript, "LOOP_REPEAT")).toBe(1);
	});

	it("treats the same arguments in a different key order as identical", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, loop: { repeatLimit: 1, maxToolCalls: 0 } } });
		let transcript = "";
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo k", timeoutMs: 5000 })]),
			fauxAssistantMessage([fauxToolCall("bash", { timeoutMs: 5000, command: "echo k" })]),
			async (ctx) => {
				transcript = JSON.stringify(ctx.messages);
				return fauxAssistantMessage("done");
			},
		]);
		await createEngine(env.deps).run({ instruction: "Order" });
		expect(transcript).toContain("LOOP_REPEAT");
	});

	it("does not treat the same arguments to a different tool as a repeat", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, loop: { repeatLimit: 1, maxToolCalls: 0 } } });
		let transcript = "";
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })]),
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "x" })]),
			async (ctx) => {
				transcript = JSON.stringify(ctx.messages);
				return fauxAssistantMessage("done");
			},
		]);
		await createEngine(env.deps).run({ instruction: "Tools" });
		expect(transcript).not.toContain("LOOP_");
	});

	it("counts tool calls per run, so a subagent's calls do not use the parent's cap", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, loop: { repeatLimit: 0, maxToolCalls: 2 } } });
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		useDispatcher(env, {
			PARENT: [fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "c", instruction: "CHILD two calls" }] })]), fauxAssistantMessage("parent done")],
			CHILD: [fauxAssistantMessage([fauxToolCall("bash", { command: "echo 1" })]), fauxAssistantMessage([fauxToolCall("bash", { command: "echo 2" })]), fauxAssistantMessage("child done")],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT" });
		expect(result.status).toBe("succeeded");
		expect(events.some((e) => e.type === "loop_guard")).toBe(false);
	});

	it("warns about the cap once, not once per blocked call in the same reply", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, loop: { repeatLimit: 0, maxToolCalls: 1 } } });
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo 1" }), fauxToolCall("bash", { command: "echo 2" }), fauxToolCall("bash", { command: "echo 3" })]),
			fauxAssistantMessage("report"),
		]);
		const result = await createEngine(env.deps).run({ instruction: "Burst" });
		expect(result).toMatchObject({ status: "succeeded", output: "report" });
		expect(events.filter((e) => e.type === "loop_guard")).toHaveLength(1);
	});

	it("keeps explore subagents away from bash and spawn", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } } } });
		let childTranscript = "";
		useDispatcher(env, {
			PARENT: [fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "s", instruction: "CHILD try", mode: "explore" }] })]), fauxAssistantMessage("parent done")],
			CHILD: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo pwned > /tmp/nexo-explore-probe" }), fauxToolCall("spawn", { tasks: [{ id: "g", instruction: "grandchild" }] })]),
				async (ctx) => {
					childTranscript = JSON.stringify(ctx.messages);
					return fauxAssistantMessage("summary");
				},
			],
		});
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		await createEngine(env.deps).run({ instruction: "PARENT" });
		expect(childTranscript).not.toContain("exit code");
		expect(events.filter((e) => e.type === "run_start")).toHaveLength(2);
	});
});
