import { createModels, Type, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CLAUDE_P_PROVIDER, claudePProvider, type ClaudePRequest, nexoModels, renderTranscript } from "../src/index.ts";

function fakeRun(lines: object[], exit: { code: number | null; stderr: string } = { code: 0, stderr: "" }) {
	const requests: ClaudePRequest[] = [];
	const run = (request: ClaudePRequest) => {
		requests.push(request);
		return {
			lines: (async function* () {
				for (const l of lines) yield JSON.stringify(l);
			})(),
			exit: Promise.resolve(exit),
		};
	};
	return { run, requests };
}

const result = (extra: object) => ({
	type: "result",
	subtype: "success",
	is_error: false,
	stop_reason: "end_turn",
	total_cost_usd: 0.25,
	usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
	...extra,
});

const delta = (index: number, text: string) => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } });

function modelsWith(run: ReturnType<typeof fakeRun>["run"]) {
	const models = createModels();
	models.setProvider(claudePProvider({ run }));
	return models;
}

describe("claude-p provider", () => {
	it("registers aliases and catalog ids under claude-p in nexoModels", () => {
		const models = nexoModels();
		expect(models.getModel(CLAUDE_P_PROVIDER, "opus")).toMatchObject({ provider: "claude-p", api: "claude-p" });
		expect(models.getModel(CLAUDE_P_PROVIDER, "claude-sonnet-5-5")?.contextWindow).toBeGreaterThan(0);
		expect(models.getModel("anthropic", "claude-sonnet-5-5")).toBeDefined();
	});

	it("streams text with Claude's tools off, the system prompt in a file and usage from the result", async () => {
		const { run, requests } = fakeRun([
			{ type: "system", subtype: "init" },
			{ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } },
			{ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			delta(0, "Hel"),
			delta(0, "lo"),
			{ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } },
			result({ result: "Hello" }),
		]);
		const models = modelsWith(run);
		const model = models.getModel(CLAUDE_P_PROVIDER, "haiku")!;
		const s = models.streamSimple(model, { systemPrompt: "Be terse.", messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { reasoning: "minimal" });
		const deltas: string[] = [];
		for await (const e of s) if (e.type === "text_delta") deltas.push(e.delta);
		const msg = await s.result();

		expect(deltas).toEqual(["Hel", "lo"]);
		expect(msg.stopReason).toBe("stop");
		expect(msg.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(msg.usage).toMatchObject({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20 });
		expect(msg.usage.cost.total).toBe(0.25);

		const req = requests[0]!;
		expect(req.stdin).toBe("hi");
		expect(req.args).toEqual(expect.arrayContaining(["-p", "--model", "haiku", "--include-partial-messages", "--effort", "low", "--system-prompt-file"]));
		expect(req.args[req.args.indexOf("--tools") + 1]).toBe("");
		expect(req.args).not.toContain("--json-schema");
	});

	it("turns structured output into tool calls when tools are passed", async () => {
		const { run, requests } = fakeRun([result({ stop_reason: "tool_use", structured_output: { text: "Reading it.", tool_calls: [{ name: "read", arguments: { path: "a.ts" } }] } })]);
		const models = modelsWith(run);
		const model = models.getModel(CLAUDE_P_PROVIDER, "sonnet")!;
		const context: Context = {
			systemPrompt: "Agent.",
			tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
			messages: [{ role: "user", content: "open a.ts", timestamp: 1 }],
		};
		const msg = await models.completeSimple(model, context);

		expect(msg.stopReason).toBe("toolUse");
		expect(msg.content[0]).toEqual({ type: "text", text: "Reading it." });
		expect(msg.content[1]).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "a.ts" } });
		const req = requests[0]!;
		const schema = JSON.parse(req.args[req.args.indexOf("--json-schema") + 1]!);
		expect(schema.properties.tool_calls.items.anyOf[0].properties.name).toEqual({ const: "read" });
		expect(schema.properties.tool_calls.items.anyOf[0].properties.arguments.properties.path.type).toBe("string");
		expect(req.args).not.toContain("--include-partial-messages");
	});

	it("reports a failed result as an error the rate-limit classifier recognises", async () => {
		const { run } = fakeRun([result({ subtype: "error_during_execution", is_error: true, api_error_status: 429, result: "Rate limited" })], { code: 1, stderr: "" });
		const models = modelsWith(run);
		const msg = await models.completeSimple(models.getModel(CLAUDE_P_PROVIDER, "opus")!, { messages: [{ role: "user", content: "x", timestamp: 1 }] });
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toBe("claude -p failed (429): Rate limited");
	});

	it("reports stderr when the CLI exits without a result", async () => {
		const { run } = fakeRun([], { code: null, stderr: "spawn claude ENOENT" });
		const models = modelsWith(run);
		const msg = await models.completeSimple(models.getModel(CLAUDE_P_PROVIDER, "opus")!, { messages: [{ role: "user", content: "x", timestamp: 1 }] });
		expect(msg.errorMessage).toBe("claude -p failed: spawn claude ENOENT");
	});
});

describe("renderTranscript", () => {
	it("renders history with tool calls and results as tagged turns", () => {
		const text = renderTranscript([
			{ role: "system", content: "sys", timestamp: 0 },
			{ role: "user", content: "open a.ts", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
				api: "claude-p",
				provider: "claude-p",
				model: "opus",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "export {}" }], isError: false, timestamp: 3 },
		]);
		expect(text).toContain("<user>\nopen a.ts\n</user>");
		expect(text).toContain('<tool_call id="c1" name="read">{"path":"a.ts"}</tool_call>');
		expect(text).toContain('<tool_result id="c1" name="read">\nexport {}\n</tool_result>');
		expect(text).not.toContain("sys");
	});
});
