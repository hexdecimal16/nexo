import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, Type, type Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { KIRO_P_IDLE_ENV, KIRO_P_PROVIDER, kiroPProvider, type KiroPRequest, type KiroPRunner, nexoModels, parseReply } from "../src/index.ts";

/** What the fake agent does for one `session/prompt`. */
interface Script {
	updates?: object[];
	stopReason?: string;
	/** JSON-RPC error message instead of a result. */
	error?: string;
	/** Never answers, except to a `session/cancel`. */
	hang?: boolean;
	/** The server process dies when this prompt arrives. */
	die?: boolean;
}

interface FakeOptions {
	/** Mode the server reports instead of the requested one. */
	mode?: string;
	/** Number of leading session/new calls that report the default mode (agent file not noticed yet). */
	lateAgentFor?: number;
}

/** A scripted ACP server: answers initialize and session/new, and plays one script per prompt (across all spawns). */
function fakeAcp(options: FakeOptions, ...scripts: Script[]) {
	const spawns: KiroPRequest[] = [];
	const sessions: { cwd: string; meta: { modeId?: string; modelId?: string; effortLevel?: string }; agent: { tools?: unknown; permissions?: unknown } }[] = [];
	const prompts: string[] = [];
	const cancels: string[] = [];

	const run: KiroPRunner = (request) => {
		spawns.push(request);
		const out: string[] = [];
		let notify: (() => void) | undefined;
		let done = false;
		let hungPrompt: number | string | undefined;
		let resolveExit!: (r: { code: number | null; stderr: string }) => void;
		const exit = new Promise<{ code: number | null; stderr: string }>((r) => {
			resolveExit = r;
		});
		const emit = (m: object) => {
			out.push(JSON.stringify({ jsonrpc: "2.0", ...m }));
			notify?.();
		};
		const stop = (code: number | null, stderr = "") => {
			done = true;
			resolveExit({ code, stderr });
			notify?.();
		};
		const lines = (async function* () {
			while (true) {
				if (out.length) {
					yield out.shift()!;
					continue;
				}
				if (done) return;
				await new Promise<void>((r) => {
					notify = r;
				});
				notify = undefined;
			}
		})();

		const write = (line: string) => {
			const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, any> };
			if (msg.method === "initialize") emit({ id: msg.id, result: { protocolVersion: 1 } });
			else if (msg.method === "session/new") {
				const meta = msg.params?._meta?.kiro ?? {};
				const agent = JSON.parse(readFileSync(join(msg.params!.cwd, ".kiro", "agents", `${meta.modeId}.json`), "utf8"));
				sessions.push({ cwd: msg.params!.cwd, meta, agent });
				const late = sessions.length <= (options.lateAgentFor ?? 0);
				emit({ id: msg.id, result: { sessionId: `s${sessions.length}`, modes: { currentModeId: late ? "vibe" : (options.mode ?? meta.modeId) } } });
			} else if (msg.method === "session/prompt") {
				prompts.push(msg.params!.prompt[0].text);
				const script = scripts[prompts.length - 1] ?? scripts.at(-1) ?? {};
				if (script.die) return stop(1, "boom");
				if (script.hang) {
					hungPrompt = msg.id;
					return;
				}
				queueMicrotask(() => {
					for (const update of script.updates ?? []) emit({ method: "session/update", params: { sessionId: msg.params!.sessionId, update } });
					if (script.error) emit({ id: msg.id, error: { code: -32000, message: script.error } });
					else emit({ id: msg.id, result: { stopReason: script.stopReason ?? "end_turn" } });
				});
			} else if (msg.method === "session/cancel") {
				cancels.push(msg.params!.sessionId);
				if (hungPrompt !== undefined) emit({ id: hungPrompt, result: { stopReason: "cancelled" } });
				hungPrompt = undefined;
			}
		};
		return { write, lines, exit, kill: () => stop(null) };
	};
	return { run, spawns, sessions, prompts, cancels };
}

const chunk = (text: string, kind = "agent_message_chunk") => ({ sessionUpdate: kind, content: { type: "text", text } });

function modelsWith(run: KiroPRunner) {
	const models = createModels();
	models.setProvider(kiroPProvider({ run }));
	return models;
}

const plain = (text = "hi"): Context => ({ messages: [{ role: "user", content: text, timestamp: 1 }] });

const toolContext = (): Context => ({
	systemPrompt: "Agent.",
	tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
	messages: [{ role: "user", content: "open a.ts", timestamp: 1 }],
});

afterEach(() => {
	delete process.env[KIRO_P_IDLE_ENV];
});

describe("kiro-p provider", () => {
	it("registers Kiro's model ids under kiro-p in nexoModels", () => {
		const models = nexoModels();
		expect(models.getModel(KIRO_P_PROVIDER, "claude-sonnet-5.5")).toMatchObject({ provider: "kiro-p", api: "kiro-p", contextWindow: 1_000_000, reasoning: true });
		expect(models.getModel(KIRO_P_PROVIDER, "auto")).toBeDefined();
		expect(models.getModel(KIRO_P_PROVIDER, "glm-5")?.cost.input).toBe(0);
	});

	it("streams text and thinking through an ACP session with a no-tools agent", async () => {
		const fake = fakeAcp({}, { updates: [chunk("hmm", "agent_thought_chunk"), chunk("Hel"), chunk("lo")] });
		const models = modelsWith(fake.run);
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
		expect(fake.spawns[0]!.args).toEqual(["acp", "--agent-engine=v3"]);
		expect(fake.sessions[0]!.meta).toEqual({ modeId: expect.stringMatching(/^nexo-[0-9a-f]{12}$/), modelId: "claude-haiku-4.5", effortLevel: "low" });
		expect(fake.prompts[0]).toBe("hi");
	});

	it("turns the JSON reply into tool calls when tools are passed", async () => {
		const fake = fakeAcp({}, { updates: [chunk('```json\n{"text":"Reading it.","tool_calls":[{"name":"read","arguments":{"path":"a.ts"}}]}\n```')] });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "claude-sonnet-5.5")!, toolContext());

		expect(msg.stopReason).toBe("toolUse");
		expect(msg.content[0]).toEqual({ type: "text", text: "Reading it." });
		expect(msg.content[1]).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "a.ts" } });
		expect(msg.content).toHaveLength(2);
	});

	it("corrects once on the same session when the tools reply is not JSON, then keeps the text", async () => {
		const fake = fakeAcp({}, { updates: [chunk("Sure, let me read it.")] }, { updates: [chunk("Still prose.")] });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, toolContext());

		expect(fake.prompts).toHaveLength(2);
		expect(fake.sessions).toHaveLength(1);
		expect(fake.prompts[1]).toContain("not a single valid JSON object");
		expect(msg.stopReason).toBe("stop");
		expect(msg.content).toEqual([{ type: "text", text: "Still prose." }]);
	});

	it("shares one server across calls and gives each call its own session", async () => {
		const fake = fakeAcp({}, { updates: [chunk("a")] });
		const models = modelsWith(fake.run);
		const model = models.getModel(KIRO_P_PROVIDER, "auto")!;
		await Promise.all([models.completeSimple(model, plain("one")), models.completeSimple(model, plain("two"))]);
		await models.completeSimple(model, plain("three"));

		expect(fake.spawns).toHaveLength(1);
		expect(fake.sessions).toHaveLength(3);
	});

	it("refuses to run when Kiro is not on the nexo agent", async () => {
		const fake = fakeAcp({ mode: "vibe" }, { updates: [chunk("hi")] });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, plain());

		expect(fake.prompts).toHaveLength(0);
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toMatch(/^kiro-cli failed: stopped: agent "nexo-[0-9a-f]{12}" not applied \(mode vibe\)$/);
	});

	it("retries session creation while Kiro has not noticed the new agent file yet", async () => {
		const fake = fakeAcp({ lateAgentFor: 2 }, { updates: [chunk("hi")] });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, plain());

		expect(fake.sessions).toHaveLength(3);
		expect(fake.prompts).toHaveLength(1);
		expect(msg.stopReason).toBe("stop");
		expect(msg.content).toEqual([{ type: "text", text: "hi" }]);
	});

	it("writes a no-tools agent that denies every Kiro capability, so the model is offered no tools at all", async () => {
		const fake = fakeAcp({}, { updates: [chunk("hi")] });
		const models = modelsWith(fake.run);
		await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, plain("x"));

		expect(fake.sessions[0]!.agent.tools).toEqual([]);
		expect(fake.sessions[0]!.agent.permissions).toEqual({ rules: [{ capability: "all", effect: "deny" }] });
	});

	it("cancels the turn when the model calls a tool natively instead of listing it in tool_calls", async () => {
		const fake = fakeAcp({}, { updates: [{ sessionUpdate: "tool_call", toolCallId: "toolu_1", title: "bash", status: "in_progress" }, chunk('{"text":"done","tool_calls":[]}')] });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "claude-sonnet-5.5")!, toolContext());

		expect(fake.cancels).toHaveLength(1);
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toBe('kiro-cli failed: stopped: native tool call "bash" (the nexo agent offers no tools)');
	});

	it("reports a prompt error", async () => {
		const fake = fakeAcp({}, { error: "The model 'x' is not available." });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, plain("x"));
		expect(msg.errorMessage).toBe("kiro-cli failed: The model 'x' is not available.");
	});

	it("replaces a server that died mid-turn and re-runs the turn once", async () => {
		const fake = fakeAcp({}, { die: true }, { updates: [chunk("back")] });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, plain("x"));

		expect(fake.spawns).toHaveLength(2);
		expect(msg.stopReason).toBe("stop");
		expect(msg.content).toEqual([{ type: "text", text: "back" }]);
	});

	it("reports the server's last stderr line when it keeps dying", async () => {
		const fake = fakeAcp({}, { die: true });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, plain("x"));

		expect(fake.spawns).toHaveLength(2);
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toBe("kiro-cli failed: boom");
	});

	it("cancels a turn that stays silent past the idle limit", async () => {
		process.env[KIRO_P_IDLE_ENV] = "50";
		const fake = fakeAcp({}, { hang: true });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, plain("x"));

		expect(fake.cancels).toHaveLength(1);
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toMatch(/no output/);
	});

	it("sends session/cancel and ends as aborted when the caller aborts", async () => {
		const fake = fakeAcp({}, { hang: true });
		const models = modelsWith(fake.run);
		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(), 30);
		const msg = await models.completeSimple(models.getModel(KIRO_P_PROVIDER, "auto")!, plain("x"), { signal: ctrl.signal });

		expect(fake.cancels).toHaveLength(1);
		expect(msg.stopReason).toBe("aborted");
	});
});

describe("parseReply", () => {
	const tools = toolContext().tools!;
	it("rejects unknown tool names and non-JSON", () => {
		expect(parseReply('{"text":"","tool_calls":[{"name":"rm","arguments":{}}]}', tools)).toBeUndefined();
		expect(parseReply("no json here", tools)).toBeUndefined();
		expect(parseReply('{"other":1}', tools)).toBeUndefined();
	});
	it("takes the last complete object when the reply repeats it after a self-correction", () => {
		const first = '{"text":"first try","tool_calls":[{"name":"read","arguments":{"path":"a.ts"}}]}';
		const second = '{"text":"second try","tool_calls":[{"name":"read","arguments":{"path":"b.ts"}}]}';
		const raw = `Starting now.\n\n\`\`\`json\n${first}\n\`\`\`\n\nWait, the reply must be a single JSON object with no code fence.\n\n${second}`;
		expect(parseReply(raw, tools)).toMatchObject({ text: "second try", calls: [{ name: "read", arguments: { path: "b.ts" } }] });
	});
	it("accepts a plain final answer", () => {
		expect(parseReply('{"text":"done","tool_calls":[]}', tools)).toEqual({ text: "done", calls: [] });
	});
});
