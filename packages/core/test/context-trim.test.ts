import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CLEARED_TOOL_OUTPUT, clearOldToolResults } from "../src/engine/context-trim.ts";
import { createEngine, type EngineEvent } from "../src/index.ts";
import { makeEnv } from "./helpers.ts";

const result = (text: string) => ({ role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 }) as never;
const user = { role: "user", content: "go", timestamp: 0 } as never;

describe("clearOldToolResults", () => {
	it("keeps the newest results and stubs older large ones", () => {
		const big = "x".repeat(1000);
		const out = clearOldToolResults([user, result(big), result(big), result(big)], 1);
		expect(out.cleared).toBe(2);
		expect((out.messages[1] as { content: { text: string }[] }).content[0]?.text).toBe(CLEARED_TOOL_OUTPUT);
		expect((out.messages[3] as { content: { text: string }[] }).content[0]?.text).toBe(big);
	});

	it("returns the same array when nothing qualifies", () => {
		const messages = [user, result("short"), result("short")];
		const out = clearOldToolResults(messages, 1);
		expect(out.cleared).toBe(0);
		expect(out.messages).toBe(messages);
	});

	it("does not change its input and leaves non-tool messages alone", () => {
		const big = "y".repeat(1000);
		const messages = [user, result(big), user, result(big)];
		const out = clearOldToolResults(messages, 0);
		expect(out.cleared).toBe(2);
		expect(out.messages[0]).toBe(user);
		expect((messages[1] as unknown as { content: { text: string }[] }).content[0]?.text).toBe(big);
	});
});

describe("mid-turn trim in a run", () => {
	it("stubs old tool outputs once a request passes session.compactAt, reports it, and keeps the stored transcript whole", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } }, session: { compactAt: 0.000001 }, loop: { repeatLimit: 0, maxToolCalls: 0 } } });
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		let finalContext = "";
		const big = (i: number) => fauxAssistantMessage([fauxToolCall("bash", { command: `printf '%0800d' 0; echo ${i}` })]);
		env.faux.setResponses([
			big(1),
			big(2),
			big(3),
			big(4),
			big(5),
			big(6),
			async (ctx) => {
				finalContext = JSON.stringify(ctx.messages);
				return fauxAssistantMessage("done");
			},
		]);
		const run = await createEngine(env.deps).run({ instruction: "Trim" });
		expect(run.status).toBe("succeeded");
		expect(finalContext).toContain(CLEARED_TOOL_OUTPUT);
		const trims = events.filter((e) => e.type === "context_trim");
		expect(trims.length).toBeGreaterThan(0);
		expect(trims.at(-1)).toMatchObject({ cleared: 2 });
		const last = trims.at(-1) as Extract<EngineEvent, { type: "context_trim" }>;
		expect(last.tokensAfter).toBeLessThan(last.tokensBefore);
		expect(JSON.stringify(run.messages)).not.toContain(CLEARED_TOOL_OUTPUT);
	});

	it("does nothing below the threshold", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } } } });
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "printf '%0800d' 0" })]), fauxAssistantMessage("done")]);
		await createEngine(env.deps).run({ instruction: "Small" });
		expect(events.some((e) => e.type === "context_trim")).toBe(false);
	});
});
