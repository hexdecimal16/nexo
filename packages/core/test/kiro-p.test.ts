import { createModels, Type, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { KIRO_P_PROVIDER, kiroPProvider, type KiroPRequest, nexoModels, parseReply } from "../src/index.ts";

interface FakeRun {
	lines: object[];
	exit?: { code: number | null; stderr: string };
	stderr?: string;
}

function fakeRun(...runs: FakeRun[]) {
	const requests: KiroPRequest[] = [];
	const run = (request: KiroPRequest) => {
		const r = runs[requests.length] ?? runs.at(-1)!;
		requests.push(request);
		if (r.stderr) request.onStderr?.(r.stderr);
		return {
			lines: (async function* () {
				for (const l of r.lines) yield JSON.stringify(l);
			})(),
			exit: Promise.resolve(r.exit ?? { code: 0, stderr: r.stderr ?? "" }),
		};
	};
	return { run, requests };
}

const chunk = (text: string, kind = "agent_message_chunk") => ({ type: "sessionUpdate", data: { update: { sessionUpdate: kind, content: { type: "text", text } } } });
const finished = (finalText: string) => ({ type: "runFinished", data: { status: "success", stopReason: "end_turn", finalText } });

function modelsWith(run: ReturnType<typeof fakeRun>["run"]) {
	const models = createModels();
	models.setProvider(kiroPProvider({ run }));
	return models;
}

const toolContext = (): Context => ({
	systemPrompt: "Agent.",
	tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
	messages: [{ role: "user", content: "open a.ts", timestamp: 1 }],
});

describe("kiro-p provider", () => {
	it("registers Kiro's model ids under kiro-p in nexoModels", () => {
		const models = nexoModels();
		expect(models.getModel(KIRO_P_PROVIDER, "claude-sonnet-5.5")).toMatchObject({ provider: "kiro-p", api: "kiro-p", contextWindow: 1_000_000, reasoning: true });
		expect(models.getModel(KIRO_P_PROVIDER, "auto")).toBeDefined();
		expect(models.getModel(KIRO_P_PROVIDER, "glm-5")?.cost.input).toBe(0);
	});

	it("streams text and thinking through a v3 run with a no-tools agent", async () => {
		const { run, requests } = fakeRun({ lines: [{ type: "runStarted" }, chunk("hmm", "agent_thought_chunk"), chunk("Hel"), chunk("lo"), finished("Hello")] });
		const models = modelsWith(run);
		const model = models.getModel(KIRO_P_PROVIDER, "claude-haiku-4.5")!;
		const s = models.streamSimple(model, { systemPrompt: "Be terse.", messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { reasoning: "minimal" });
		const deltas: string[] = [];
		for await (const e of s) if (e.type === "text_delta") deltas.push(e.delta);
		const msg = await s.result();

		expect(deltas).toEqual(["Hel", "lo"]);
		expect(msg.stopReason).toBe("stop");
		expect(msg.content).toEqual([
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "Hello" },
		]);
		const req = requests[0]!;
		expect(req.stdin).toBe("hi");
		expect(req.args).toEqual(expect.arrayContaining(["chat", "--v3", "--no-interactive", "--agent", "nexo", "--trust-tools=", "--model", "claude-haiku-4.5", "--effort", "low"]));
	});

	it("turns the JSON reply into tool calls when tools are passed", async () => {
		const { run } = fakeRun({ lines: [chunk("ignored"), finished('```json\n{"text":"Reading it.","tool_calls":[{"name":"read","arguments":{"path":"a.ts"}}]}\n```')] });
		const models = modelsWith(run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "claude-sonnet-5.5")!, toolContext());

		expect(msg.stopReason).toBe("toolUse");
		expect(msg.content[0]).toEqual({ type: "text", text: "Reading it." });
		expect(msg.content[1]).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "a.ts" } });
		expect(msg.content).toHaveLength(2);
	});

	it("retries once when the tools reply is not JSON, then keeps the text", async () => {
		const { run, requests } = fakeRun({ lines: [finished("Sure, let me read it.")] }, { lines: [finished("Still prose.")] });
		const models = modelsWith(run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, toolContext());

		expect(requests).toHaveLength(2);
		expect(requests[1]!.stdin).toContain("not a single valid JSON object");
		expect(msg.stopReason).toBe("stop");
		expect(msg.content).toEqual([{ type: "text", text: "Still prose." }]);
	});

	it("stops the run when Kiro falls back from the nexo agent", async () => {
		const { run, requests } = fakeRun({ lines: [finished("hi")], stderr: '[warn] agent "nexo" not found, using "default"\n' });
		const models = modelsWith(run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, { messages: [{ role: "user", content: "x", timestamp: 1 }] });

		expect(requests[0]!.signal?.aborted).toBe(true);
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toBe('kiro-cli failed: stopped: agent "nexo" not found, using "default"');
	});

	it("reports a runError event", async () => {
		const { run } = fakeRun({ lines: [{ type: "runError", data: { stage: "prompt", message: "The model 'x' is not available." } }] });
		const models = modelsWith(run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, { messages: [{ role: "user", content: "x", timestamp: 1 }] });
		expect(msg.errorMessage).toBe("kiro-cli failed: The model 'x' is not available.");
	});

	it("reports stderr when the CLI exits without a result", async () => {
		const { run } = fakeRun({ lines: [], exit: { code: null, stderr: "spawn kiro-cli ENOENT" } });
		const models = modelsWith(run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, { messages: [{ role: "user", content: "x", timestamp: 1 }] });
		expect(msg.errorMessage).toBe("kiro-cli failed: spawn kiro-cli ENOENT");
	});
});

describe("parseReply", () => {
	const tools = toolContext().tools!;
	it("rejects unknown tool names and non-JSON", () => {
		expect(parseReply('{"text":"","tool_calls":[{"name":"rm","arguments":{}}]}', tools)).toBeUndefined();
		expect(parseReply("no json here", tools)).toBeUndefined();
		expect(parseReply('{"other":1}', tools)).toBeUndefined();
	});
	it("accepts a plain final answer", () => {
		expect(parseReply('{"text":"done","tool_calls":[]}', tools)).toEqual({ text: "done", calls: [] });
	});
});
