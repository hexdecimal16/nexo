import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type Context, type Message } from "@earendil-works/pi-ai";
import { resolveNexoPaths } from "@nexo/store";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { classifyProviderError } from "../src/engine/errors.ts";
import {
	AGY_P_BAD_REPLY,
	AGY_P_IDLE_ENV,
	AGY_P_PROVIDER,
	agyPProvider,
	agyTranscriptParts,
	type AgyPRequest,
	type AgyPRunner,
	createSettings,
	extractMcpToolCall,
	mirrorGeminiDir,
	nexoModels,
	parseAgyReply,
	resolveThoughtLevel,
} from "../src/index.ts";

/** What the fake ACP server does for one `session/prompt`. */
interface Script {
	updates?: object[];
	/** Raw stdout lines emitted before the response (for malformed-frame testing). */
	rawLines?: string[];
	/** Agent-to-client JSON-RPC requests sent during the prompt. */
	agentRequests?: { id: number | string; method: string; params?: unknown }[];
	stopReason?: string;
	usage?: Record<string, unknown>;
	/** JSON-RPC error instead of a result. */
	error?: string | { code?: number; message?: string; data?: unknown };
	/** Never answers, except to a `session/cancel`. */
	hang?: boolean;
	/** The server process dies when this prompt arrives. */
	die?: boolean;
}

interface FakeOptions {
	/** `thought_level` values available per model; omit a model to simulate no thought_level option. */
	thoughtLevels?: Record<string, { current: string; values: string[] }>;
	/** Fail `initialize` by exiting on the N-th spawn (1-based). */
	failInitSpawns?: Record<number, { code: number | null; stderr: string }>;
	/** Override `session/new` behavior on the N-th call (1-based). */
	sessionNewOverrides?: Record<number, "die" | "empty" | "hang">;
	/** Fail `session/set_config_option` with a JSON-RPC error. */
	setConfigError?: { code?: number; message?: string; data?: unknown };
	/** Ignore `session/close` requests (never respond) to test non-blocking cleanup. */
	ignoreClose?: boolean;
}

const DEFAULT_THOUGHT_LEVELS: Record<string, { current: string; values: string[] }> = {
	"gemini-4-neon": { current: "high", values: ["low", "medium", "high", "xhigh"] },
	"gemini-3.8-flash": { current: "high", values: ["low", "medium", "high"] },
	"claude-sonnet-5-5": { current: "high", values: ["low", "medium", "high"] },
};

/** A scripted ACP server matching `agy acp`: answers initialize, session/new, session/set_config_option, session/prompt, session/close. */
function fakeAcp(options: FakeOptions, ...scripts: Script[]) {
	const spawns: AgyPRequest[] = [];
	const agents: string[] = [];
	const sessions: { cwd: string; systemPrompt?: string }[] = [];
	const configSets: { sessionId: string; configId: string; value: string }[] = [];
	const prompts: string[] = [];
	const promptBlocks: { type: string; text?: string; data?: string; mimeType?: string }[][] = [];
	const cancels: string[] = [];
	const closes: string[] = [];
	const clientReplies: Record<string, unknown>[] = [];
	const holds: boolean[] = [];
	const levelsByModel = options.thoughtLevels ?? DEFAULT_THOUGHT_LEVELS;
	let sessionNewCalls = 0;

	const run: AgyPRunner = (request) => {
		const spawnIdx = spawns.length + 1;
		spawns.push(request);
		agents.push(readFileSync(join(request.cwd, ".agents", "agents", "nexo.md"), "utf8"));
		const out: string[] = [];
		let notify: (() => void) | undefined;
		let done = false;
		let hungPrompt: number | string | undefined;
		let resolveExit!: (r: { code: number | null; stderr: string }) => void;
		const exit = new Promise<{ code: number | null; stderr: string }>((r) => {
			resolveExit = r;
		});
		const emitRaw = (raw: string) => {
			out.push(raw);
			notify?.();
		};
		const emit = (m: object) => emitRaw(JSON.stringify({ jsonrpc: "2.0", ...m }));
		const stop = (code: number | null, stderr = "") => {
			if (done) return;
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

		const configOptionsFor = (modelId: string) => {
			const tl = levelsByModel[modelId];
			return tl ? [{ id: "model", currentValue: modelId }, { id: "thought_level", currentValue: tl.current, options: tl.values.map((v) => ({ value: v })) }] : [{ id: "model", currentValue: modelId }];
		};

		const write = (line: string) => {
			const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, any>; result?: unknown; error?: unknown };
			if (!msg.method && msg.id !== undefined) {
				clientReplies.push(msg);
				return;
			}
			if (msg.method === "initialize") {
				const initFail = options.failInitSpawns?.[spawnIdx];
				if (initFail) return stop(initFail.code, initFail.stderr);
				emit({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true }, _meta: { antigravity: { systemPrompt: { append: true } } } } } });
			} else if (msg.method === "session/new") {
				sessionNewCalls++;
				const override = options.sessionNewOverrides?.[sessionNewCalls];
				if (override === "die") return stop(1, "stale server died");
				if (override === "empty") return emit({ id: msg.id, result: {} });
				if (override === "hang") return;
				sessions.push({ cwd: msg.params!.cwd, systemPrompt: msg.params?._meta?.antigravity?.systemPrompt?.append });
				emit({ id: msg.id, result: { sessionId: `s${sessions.length}`, configOptions: configOptionsFor("gemini-4-neon") } });
			} else if (msg.method === "session/set_config_option") {
				if (options.setConfigError) return emit({ id: msg.id, error: options.setConfigError });
				const { sessionId, configId, value } = msg.params as { sessionId: string; configId: string; value: string };
				configSets.push({ sessionId, configId, value });
				emit({ id: msg.id, result: configId === "model" ? { configOptions: configOptionsFor(value) } : {} });
			} else if (msg.method === "session/prompt") {
				prompts.push(msg.params!.prompt[0]?.text ?? "");
				promptBlocks.push(msg.params!.prompt);
				const script = scripts[prompts.length - 1] ?? scripts.at(-1) ?? {};
				if (script.die) return stop(1, "boom");
				if (script.hang) {
					hungPrompt = msg.id;
					return;
				}
				queueMicrotask(() => {
					for (const raw of script.rawLines ?? []) emitRaw(raw);
					for (const req of script.agentRequests ?? []) emit(req);
					for (const update of script.updates ?? []) emit({ method: "session/update", params: { sessionId: msg.params!.sessionId, update } });
					if (script.error) {
						const err = typeof script.error === "string" ? { code: -32000, message: script.error } : script.error;
						emit({ id: msg.id, error: err });
					} else emit({ id: msg.id, result: { stopReason: script.stopReason ?? "end_turn", ...(script.usage ? { usage: script.usage } : {}) } });
				});
			} else if (msg.method === "session/cancel") {
				cancels.push(msg.params!.sessionId);
				if (hungPrompt !== undefined) emit({ id: hungPrompt, result: { stopReason: "cancelled" } });
				hungPrompt = undefined;
			} else if (msg.method === "session/close") {
				closes.push(msg.params!.sessionId);
				if (!options.ignoreClose) emit({ id: msg.id, result: {} });
			}
		};
		return {
			write,
			lines,
			exit,
			kill: () => stop(null),
			hold: (on) => holds.push(on),
		};
	};
	return { run, spawns, agents, sessions, configSets, prompts, promptBlocks, cancels, closes, clientReplies, holds };
}

const chunk = (text: string, kind = "agent_message_chunk") => ({ sessionUpdate: kind, content: { type: "text", text } });

function modelsWith(run: AgyPRunner, geminiDir: string | null = null) {
	const models = createModels();
	models.setProvider(agyPProvider({ run, geminiDir }));
	return models;
}

const plain = (text = "hi"): Context => ({ messages: [{ role: "user", content: text, timestamp: 1 }] });

const toolContext = (): Context => ({
	systemPrompt: "Agent.",
	tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
	messages: [{ role: "user", content: "open a.ts", timestamp: 1 }],
});

const tempDirs: string[] = [];
afterEach(() => {
	delete process.env[AGY_P_IDLE_ENV];
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("agy-p provider", () => {
	it("registers Antigravity's base model ids under agy-p in nexoModels with $0 cost and ambient CLI auth", () => {
		const models = nexoModels();
		expect(models.getModel(AGY_P_PROVIDER, "gemini-4-neon")).toMatchObject({
			provider: "agy-p",
			api: "agy-p",
			contextWindow: 1_048_576,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(models.getModel(AGY_P_PROVIDER, "gemini-3.8-flash")).toMatchObject({ provider: "agy-p", reasoning: true });
		expect(models.getModel(AGY_P_PROVIDER, "claude-sonnet-5-5")).toMatchObject({ provider: "agy-p", contextWindow: 1_000_000, reasoning: true });
		expect(models.getModel(AGY_P_PROVIDER, "gpt-oss-120b-medium")).toMatchObject({ provider: "agy-p", reasoning: false });

		const home = mkdtempSync(join(tmpdir(), "nexo-agy-settings-"));
		tempDirs.push(home);
		const settings = createSettings({ paths: resolveNexoPaths({ NEXO_HOME: home }), cwd: home, models, env: {} });
		expect(settings.keyStatus(AGY_P_PROVIDER)).toEqual({
			provider: AGY_P_PROVIDER,
			purpose: "model",
			state: "env",
			envVar: null,
			last4: null,
			inFile: false,
		});
	});

	it("streams thinking and text, passes systemPrompt.append, sets model + thought_level, and maps token usage at $0 cost", async () => {
		const fake = fakeAcp(
			{},
			{
				updates: [chunk("hmm", "agent_thought_chunk"), chunk("Hel"), chunk("lo")],
				usage: { inputTokens: 1000, outputTokens: 50, cachedReadTokens: 200, cachedWriteTokens: 0, thoughtTokens: 20, totalTokens: 1050 },
			},
		);
		const models = modelsWith(fake.run);
		const model = models.getModel(AGY_P_PROVIDER, "gemini-3.8-flash")!;
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
		expect(msg.usage).toEqual({
			input: 800,
			output: 50,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1050,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});

		expect(fake.spawns[0]!.args).toEqual(["acp", "--agent", "nexo", "--include-default-customizations=false"]);
		expect(fake.agents[0]).toContain("tools: []");
		expect(fake.sessions[0]!.systemPrompt).toBe("Be terse.");
		expect(fake.configSets).toEqual([
			{ sessionId: "s1", configId: "model", value: "gemini-3.8-flash" },
			{ sessionId: "s1", configId: "thought_level", value: "low" },
		]);
		expect(fake.prompts[0]).toBe("hi");
		expect(fake.closes).toEqual(["s1"]);
	});

	it("clamps xhigh/max effort to high on models without xhigh and skips thought_level on models without it", async () => {
		const fake = fakeAcp({}, { updates: [chunk("ok")] }, { updates: [chunk("ok")] }, { updates: [chunk("ok")] });
		const models = modelsWith(fake.run);

		await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-3.8-flash")!, plain(), { reasoning: "xhigh" });
		await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain(), { reasoning: "xhigh" });
		await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gpt-oss-120b-medium")!, plain(), { reasoning: "low" });

		expect(fake.spawns).toHaveLength(1);
		expect(fake.configSets).toEqual([
			{ sessionId: "s1", configId: "model", value: "gemini-3.8-flash" },
			{ sessionId: "s2", configId: "model", value: "gemini-4-neon" },
			{ sessionId: "s2", configId: "thought_level", value: "xhigh" },
			{ sessionId: "s3", configId: "model", value: "gpt-oss-120b-medium" },
		]);
	});

	it("turns a JSON tools reply into real tool calls and streams the text field while it is written", async () => {
		const fake = fakeAcp(
			{},
			{ updates: [chunk('{"text": "Read'), chunk('ing it.", "tool_calls": [{"name": "read", "arguments": {"path": "a.ts"}}]}')] },
		);
		const models = modelsWith(fake.run);
		const s = models.streamSimple(models.getModel(AGY_P_PROVIDER, "claude-sonnet-5-5")!, toolContext());
		const deltas: string[] = [];
		for await (const e of s) if (e.type === "text_delta") deltas.push(e.delta);
		const msg = await s.result();

		expect(deltas).toEqual(["Read", "ing it."]);
		expect(msg.stopReason).toBe("toolUse");
		expect(msg.content[0]).toEqual({ type: "text", text: "Reading it." });
		expect(msg.content[1]).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "a.ts" } });
		expect((msg.content[1] as { id: string }).id).toMatch(/^agy_p_/);
		expect(fake.sessions[0]!.systemPrompt).toContain("# Actions");
	});

	it("retries once in the same session when a tools reply is not valid JSON and sums token usage", async () => {
		const fake = fakeAcp(
			{},
			{ updates: [chunk('{"text": "broken')], usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
			{ updates: [chunk('{"text": "Fixed.", "tool_calls": []}')], usage: { inputTokens: 120, outputTokens: 15, totalTokens: 135 } },
		);
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, toolContext());

		expect(fake.sessions).toHaveLength(1);
		expect(fake.prompts).toHaveLength(2);
		expect(msg.stopReason).toBe("stop");
		expect(msg.content).toEqual([{ type: "text", text: "Fixed." }]);
		expect(msg.usage).toMatchObject({ input: 220, output: 25, totalTokens: 245 });
	});

	it("keeps plain-prose fallback on a tools turn after retry, but fails on botched JSON attempts", async () => {
		const prose = fakeAcp({}, { updates: [chunk("Just prose.")] }, { updates: [chunk("Still plain prose.")] });
		const msgProse = await modelsWith(prose.run).completeSimple(modelsWith(prose.run).getModel(AGY_P_PROVIDER, "gemini-4-neon")!, toolContext());
		expect(msgProse.stopReason).toBe("stop");
		expect(msgProse.content).toEqual([{ type: "text", text: "Still plain prose." }]);

		const bad = fakeAcp({}, { updates: [chunk('{"tool_calls": [{"name": "nope"}]}')] }, { updates: [chunk('{"tool_calls": [{"name": "nope"}]}')] });
		const models = modelsWith(bad.run);
		const msgBad = await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, toolContext());
		expect(msgBad.stopReason).toBe("error");
		expect(msgBad.errorMessage).toBe(`agy failed: ${AGY_P_BAD_REPLY}`);
	});

	it("maps max_tokens to stopReason length", async () => {
		const fake = fakeAcp({}, { updates: [chunk("cut off")], stopReason: "max_tokens" });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain());
		expect(msg.stopReason).toBe("length");
		expect(msg.content).toEqual([{ type: "text", text: "cut off" }]);
	});

	it("cancels a native tool call, corrects it once in the same session, and fails as a format error if it persists", async () => {
		const fake = fakeAcp({}, { updates: [{ sessionUpdate: "tool_call", title: "manage_task" }] });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, toolContext());

		expect(fake.sessions).toHaveLength(1);
		expect(fake.cancels).toEqual(["s1", "s1"]);
		expect(fake.prompts[1]).toContain('The tool "manage_task" is not available');
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toContain('native tool call "manage_task"');
		expect(classifyProviderError(msg.errorMessage!).code).toBe("PROVIDER_UNAVAILABLE");
	});

	it("recovers from a native tool call when the corrected reply is valid, summing usage", async () => {
		const fake = fakeAcp(
			{},
			{ updates: [{ sessionUpdate: "tool_call", title: "MCP Tool get_current_time" }], usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } },
			{ updates: [chunk('{"text": "Reading.", "tool_calls": [{"name": "read", "arguments": {"path": "a.ts"}}]}')], usage: { inputTokens: 110, outputTokens: 20, totalTokens: 130 } },
		);
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, toolContext());

		expect(fake.sessions).toHaveLength(1);
		expect(fake.prompts).toHaveLength(2);
		expect(msg.stopReason).toBe("toolUse");
		expect(msg.content).toMatchObject([{ type: "text", text: "Reading." }, { type: "toolCall", name: "read", arguments: { path: "a.ts" } }]);
		expect(msg.usage).toMatchObject({ output: 20, totalTokens: 130 });
	});

	it("recovers call_mcp_tool targeting a declared nexo action into a real ToolCall", async () => {
		const fake = fakeAcp(
			{},
			{
				updates: [
					chunk("Checking the file."),
					{
						sessionUpdate: "tool_call",
						toolCallId: "c1",
						name: "call_mcp_tool",
						title: "MCP Tool read",
						args: { ServerName: "nexo", ToolName: "read", Arguments: { path: "a.ts" } },
					},
					// Duplicate update for the same toolCallId is ignored.
					{
						sessionUpdate: "tool_call",
						toolCallId: "c1",
						name: "call_mcp_tool",
						title: "MCP Tool read",
						args: { ServerName: "nexo", ToolName: "read", Arguments: { path: "a.ts" } },
					},
				],
				stopReason: "cancelled",
				usage: { inputTokens: 300, outputTokens: 20, totalTokens: 320 },
			},
		);
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-3.8-flash")!, toolContext());

		expect(fake.cancels).toEqual(["s1"]);
		expect(msg.stopReason).toBe("toolUse");
		expect(msg.content[0]).toEqual({ type: "text", text: "Checking the file." });
		expect(msg.content[1]).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "a.ts" } });
		expect((msg.content[1] as { id: string }).id).toMatch(/^agy_p_/);
		expect(msg.usage).toMatchObject({ input: 300, output: 20, totalTokens: 320 });
	});

	it("rejects call_mcp_tool for non-nexo MCP tools, mixed native calls, bad arguments, or plain turns", async () => {
		// Real MCP tool not in nexo's declared tools
		const unknownMcp = fakeAcp(
			{},
			{
				updates: [
					{
						sessionUpdate: "tool_call",
						toolCallId: "c1",
						name: "call_mcp_tool",
						title: "MCP Tool get_logs",
						args: { ServerName: "last9", ToolName: "get_logs", Arguments: {} },
					},
				],
			},
		);
		const m1 = await modelsWith(unknownMcp.run).completeSimple(modelsWith(unknownMcp.run).getModel(AGY_P_PROVIDER, "gemini-3.8-flash")!, toolContext());
		expect(m1.stopReason).toBe("error");
		expect(m1.errorMessage).toContain('native tool call "MCP Tool get_logs"');

		// Mixed known nexo call + forbidden native manage_task
		const mixed = fakeAcp(
			{},
			{
				updates: [
					{
						sessionUpdate: "tool_call",
						toolCallId: "c1",
						name: "call_mcp_tool",
						title: "MCP Tool read",
						args: { ToolName: "read", Arguments: { path: "a.ts" } },
					},
					{ sessionUpdate: "tool_call", toolCallId: "c2", name: "manage_task", title: "manage_task" },
				],
			},
		);
		const m2 = await modelsWith(mixed.run).completeSimple(modelsWith(mixed.run).getModel(AGY_P_PROVIDER, "gemini-3.8-flash")!, toolContext());
		expect(m2.stopReason).toBe("error");
		expect(m2.errorMessage).toContain('native tool call "manage_task"');

		// Plain turn (no nexo tools offered) must never recover call_mcp_tool
		const noTools = fakeAcp(
			{},
			{
				updates: [
					{
						sessionUpdate: "tool_call",
						toolCallId: "c1",
						name: "call_mcp_tool",
						title: "MCP Tool read",
						args: { ToolName: "read", Arguments: { path: "a.ts" } },
					},
				],
			},
		);
		const m3 = await modelsWith(noTools.run).completeSimple(modelsWith(noTools.run).getModel(AGY_P_PROVIDER, "gemini-3.8-flash")!, plain());
		expect(m3.stopReason).toBe("error");
		expect(m3.errorMessage).toContain('native tool call "MCP Tool read"');

		// Unit checks on extractMcpToolCall edge cases
		const known = new Set(["read", "bash"]);
		expect(extractMcpToolCall({ name: "call_mcp_tool", rawInput: { ToolName: "bash", Arguments: '{"command":"ls"}' } }, known)).toMatchObject({
			type: "toolCall",
			name: "bash",
			arguments: { command: "ls" },
		});
		expect(extractMcpToolCall({ name: "call_mcp_tool", args: { ToolName: "bash" } }, known)).toMatchObject({ name: "bash", arguments: {} });
		expect(extractMcpToolCall({ name: "call_mcp_tool", args: { ToolName: "bash", Arguments: [1, 2] } }, known)).toBeUndefined();
		expect(extractMcpToolCall({ name: "call_mcp_tool", args: { ToolName: "bash", Arguments: "{bad" } }, known)).toBeUndefined();
		expect(extractMcpToolCall({ name: "manage_task", args: { Action: "list" } }, known)).toBeUndefined();
	});

	it("refuses session/request_permission (including malformed options) and returns -32601 for unknown agent requests", async () => {
		const fake = fakeAcp(
			{},
			{
				agentRequests: [
					{ id: "p1", method: "session/request_permission", params: { options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } },
					{ id: "p2", method: "session/request_permission", params: { options: [{ optionId: "deny_all", kind: "reject_always" }] } },
					{ id: "p3", method: "session/request_permission", params: { options: "not-an-array" } },
					{ id: "u1", method: "fs/read_text_file", params: { path: "/etc/passwd" } },
				],
				updates: [chunk("safe")],
			},
		);
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain());

		expect(msg.stopReason).toBe("stop");
		expect(msg.content).toEqual([{ type: "text", text: "safe" }]);
		expect(fake.clientReplies).toEqual([
			{ jsonrpc: "2.0", id: "p1", result: { outcome: { outcome: "selected", optionId: "deny" } } },
			{ jsonrpc: "2.0", id: "p2", result: { outcome: { outcome: "selected", optionId: "deny_all" } } },
			{ jsonrpc: "2.0", id: "p3", result: { outcome: { outcome: "cancelled" } } },
			{ jsonrpc: "2.0", id: "u1", error: { code: -32601, message: "Method not found" } },
		]);
	});

	it("ignores malformed stdout lines, null ids/updates, and clamps invalid usage fields", async () => {
		const fake = fakeAcp(
			{},
			{
				rawLines: [
					"not valid json",
					"null",
					JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
					JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: null } }),
				],
				updates: [chunk("ok")],
				usage: { inputTokens: -50, outputTokens: Number.NaN, cachedReadTokens: "bad", cachedWriteTokens: null, totalTokens: Infinity },
			},
		);
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain());

		expect(msg.stopReason).toBe("stop");
		expect(msg.content).toEqual([{ type: "text", text: "ok" }]);
		expect(msg.usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});

	it("surfaces JSON-RPC error.data details so upstream rate limits and auth errors classify accurately", async () => {
		const fake = fakeAcp(
			{},
			{ error: { code: -32603, message: "Internal error", data: { details: "429 RESOURCE_EXHAUSTED: quota limit reached" } } },
			{ error: { code: -32000, message: "Authentication required", data: "401 unauthorized" } },
		);
		const models = modelsWith(fake.run);
		const model = models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!;

		const rateErr = await models.completeSimple(model, plain());
		expect(rateErr.stopReason).toBe("error");
		expect(rateErr.errorMessage).toContain("429 RESOURCE_EXHAUSTED");
		expect(classifyProviderError(rateErr.errorMessage!).code).toBe("PROVIDER_RATE_LIMIT");

		const authErr = await models.completeSimple(model, plain());
		expect(authErr.stopReason).toBe("error");
		expect(classifyProviderError(authErr.errorMessage!).code).toBe("PROVIDER_AUTH");
	});

	it("reports startup/ENOENT failures cleanly and retries spawning on the next call", async () => {
		const fake = fakeAcp({ failInitSpawns: { 1: { code: null, stderr: "spawn agy ENOENT" } } }, { updates: [chunk("up")] });
		const models = modelsWith(fake.run);
		const model = models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!;

		const first = await models.completeSimple(model, plain());
		expect(first.stopReason).toBe("error");
		expect(first.errorMessage).toBe("agy failed: spawn agy ENOENT");

		const second = await models.completeSimple(model, plain());
		expect(second.stopReason).toBe("stop");
		expect(second.content).toEqual([{ type: "text", text: "up" }]);
		expect(fake.spawns).toHaveLength(2);
	});

	it("auto-heals when a shared server dies during session/new or mid-prompt before streaming", async () => {
		const fakeNew = fakeAcp({ sessionNewOverrides: { 1: "die" } }, { updates: [chunk("Recovered after session/new.")] });
		const m1 = await modelsWith(fakeNew.run).completeSimple(modelsWith(fakeNew.run).getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain());
		expect(fakeNew.spawns).toHaveLength(2);
		expect(m1.stopReason).toBe("stop");
		expect(m1.content).toEqual([{ type: "text", text: "Recovered after session/new." }]);

		const fakePrompt = fakeAcp({}, { die: true }, { updates: [chunk("Recovered after prompt.")] });
		const m2 = await modelsWith(fakePrompt.run).completeSimple(modelsWith(fakePrompt.run).getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain("x"));
		expect(fakePrompt.spawns).toHaveLength(2);
		expect(m2.stopReason).toBe("stop");
		expect(m2.content).toEqual([{ type: "text", text: "Recovered after prompt." }]);
	});

	it("fails cleanly when session/new returns no sessionId and closes the session when set_config_option fails", async () => {
		const emptySess = fakeAcp({ sessionNewOverrides: { 1: "empty" } });
		const m1 = await modelsWith(emptySess.run).completeSimple(modelsWith(emptySess.run).getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain());
		expect(m1.stopReason).toBe("error");
		expect(m1.errorMessage).toBe("agy failed: session/new returned no sessionId");

		const badConfig = fakeAcp({ setConfigError: { code: -32602, message: "Invalid model", data: "unknown model id" } });
		const m2 = await modelsWith(badConfig.run).completeSimple(modelsWith(badConfig.run).getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain());
		expect(m2.stopReason).toBe("error");
		expect(m2.errorMessage).toBe("agy failed: Invalid model: unknown model id");
		expect(badConfig.closes).toEqual(["s1"]);
	});

	it("releases the process hold when idle even if session/close never responds", async () => {
		const fake = fakeAcp({ ignoreClose: true }, { updates: [chunk("done")] });
		const models = modelsWith(fake.run);
		const msg = await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain());

		expect(msg.stopReason).toBe("stop");
		expect(fake.closes).toEqual(["s1"]);
		expect(fake.holds.at(-1)).toBe(false);
	});

	it("cancels a hung turn after NEXO_AGY_P_IDLE_MS and ignores invalid idle env values", async () => {
		process.env[AGY_P_IDLE_ENV] = "-10";
		const okFake = fakeAcp({}, { updates: [chunk("still ok")] });
		const ok = await modelsWith(okFake.run).completeSimple(modelsWith(okFake.run).getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain());
		expect(ok.stopReason).toBe("stop");

		process.env[AGY_P_IDLE_ENV] = "50";
		const hung = fakeAcp({}, { hang: true });
		const msg = await modelsWith(hung.run).completeSimple(modelsWith(hung.run).getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain("x"));
		expect(hung.cancels).toEqual(["s1"]);
		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toMatch(/no output for \d+s/);
	});

	it("aborts immediately before start, during session/new, and during an in-flight prompt", async () => {
		const preAborted = new AbortController();
		preAborted.abort();
		const fakePre = fakeAcp({});
		const modelsPre = modelsWith(fakePre.run);
		const mPre = await modelsPre.completeSimple(modelsPre.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain(), { signal: preAborted.signal });
		expect(mPre.errorMessage).toMatch(/abort/i);
		expect(fakePre.spawns).toHaveLength(0);

		const duringNew = new AbortController();
		setTimeout(() => duringNew.abort(), 20);
		const fakeNew = fakeAcp({ sessionNewOverrides: { 1: "hang" } });
		const modelsNew = modelsWith(fakeNew.run);
		const mNew = await modelsNew.completeSimple(modelsNew.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain(), { signal: duringNew.signal });
		expect(mNew.stopReason).toBe("aborted");

		const duringPrompt = new AbortController();
		setTimeout(() => duringPrompt.abort(), 20);
		const fakePrompt = fakeAcp({}, { hang: true });
		const modelsPrompt = modelsWith(fakePrompt.run);
		const mPrompt = await modelsPrompt.completeSimple(modelsPrompt.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain("x"), { signal: duringPrompt.signal });
		expect(fakePrompt.cancels).toEqual(["s1"]);
		expect(mPrompt.stopReason).toBe("aborted");
	});
});

describe("agyTranscriptParts", () => {
	const assistant = (thinking: string, extra: Partial<{ redacted: boolean }> = {}): Message =>
		({
			role: "assistant",
			content: [{ type: "thinking", thinking, ...extra }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
			api: "agy-p",
			provider: "agy-p",
			model: "m",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
		}) as Message;
	const result = (text: string): Message => ({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 1 });
	const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
	const textOf = (messages: Message[]) => agyTranscriptParts(messages).map((p) => (p.type === "text" ? p.text : "[image]")).join("");

	it("sends a lone user message as-is", () => {
		expect(textOf([user("hi")])).toBe("hi");
	});

	it("carries earlier reasoning forward as <notes>, keeping the end of long reasoning and skipping redacted thinking", () => {
		const long = `start ${"x".repeat(3000)} conclusion: the bug is in parse()`;
		const text = textOf([user("debug it"), assistant(long), result("out"), assistant("secret", { redacted: true }), result("out2")]);
		expect(text).toContain("<assistant>\n<notes>\n…");
		expect(text).toContain("conclusion: the bug is in parse()\n</notes>\n<tool_call");
		expect(text).not.toContain("start x");
		expect(text).not.toContain("secret");
		expect(text.trimEnd().endsWith("continuing from the last entry above.")).toBe(true);
	});

	it("limits notes to the latest 20 assistant turns and calls out a new user message at the end", () => {
		const messages: Message[] = [user("go")];
		for (let i = 0; i < 25; i++) messages.push(assistant(`thought-${i}.`), result(`r${i}`));
		messages.push(user("stop and summarise"));
		const text = textOf(messages);
		expect(text).not.toContain("thought-4.");
		expect(text).toContain("thought-5.");
		expect(text).toContain("thought-24.");
		expect(text).toContain("The last <user> entry is the user's newest message");
	});
});

describe("mirrorGeminiDir", () => {
	it("links every entry except the MCP config, which lists no servers, and removing the mirror leaves the source intact", () => {
		const source = mkdtempSync(join(tmpdir(), "nexo-agy-gemini-"));
		const workspace = mkdtempSync(join(tmpdir(), "nexo-agy-ws-"));
		tempDirs.push(source, workspace);
		mkdirSync(join(source, "antigravity-cli"));
		writeFileSync(join(source, "antigravity-cli", "antigravity-oauth-token"), "tok");
		mkdirSync(join(source, "config"));
		writeFileSync(join(source, "config", "config.json"), "{}");
		writeFileSync(join(source, "config", "mcp_config.json"), '{"mcpServers":{"last9":{"serverUrl":"https://x"}}}');

		const mirror = mirrorGeminiDir(source, workspace)!;
		expect(mirror).toBe(join(workspace, ".gemini-home"));
		expect(readlinkSync(join(mirror, "antigravity-cli"))).toBe(join(source, "antigravity-cli"));
		expect(readlinkSync(join(mirror, "config", "config.json"))).toBe(join(source, "config", "config.json"));
		expect(lstatSync(join(mirror, "config", "mcp_config.json")).isSymbolicLink()).toBe(false);
		expect(JSON.parse(readFileSync(join(mirror, "config", "mcp_config.json"), "utf8"))).toEqual({ mcpServers: {} });

		rmSync(workspace, { recursive: true, force: true });
		expect(readFileSync(join(source, "antigravity-cli", "antigravity-oauth-token"), "utf8")).toBe("tok");
		expect(readFileSync(join(source, "config", "mcp_config.json"), "utf8")).toContain("last9");
	});

	it("returns undefined when there is no Antigravity directory", () => {
		const workspace = mkdtempSync(join(tmpdir(), "nexo-agy-ws-"));
		tempDirs.push(workspace);
		expect(mirrorGeminiDir(join(workspace, "missing"), workspace)).toBeUndefined();
	});

	it("starts the server with --gemini-dir pointing at the mirror", async () => {
		const source = mkdtempSync(join(tmpdir(), "nexo-agy-gemini-"));
		tempDirs.push(source);
		mkdirSync(join(source, "config"));
		writeFileSync(join(source, "config", "mcp_config.json"), '{"mcpServers":{"last9":{}}}');
		const fake = fakeAcp({}, { updates: [chunk("hi")] });
		const models = modelsWith(fake.run, source);
		await models.completeSimple(models.getModel(AGY_P_PROVIDER, "gemini-4-neon")!, plain());
		const { args, cwd } = fake.spawns[0]!;
		expect(args).toEqual(["acp", "--agent", "nexo", "--include-default-customizations=false", "--gemini-dir", join(cwd, ".gemini-home")]);
	});
});

describe("resolveThoughtLevel & parseAgyReply", () => {
	it("maps minimal/max, clamps to available options, and handles missing/malformed options safely", () => {
		const opts = [{ id: "thought_level", currentValue: "medium", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] }];
		expect(resolveThoughtLevel(undefined, opts)).toBeUndefined();
		expect(resolveThoughtLevel("minimal", opts)).toBe("low");
		expect(resolveThoughtLevel("medium", opts)).toBeUndefined();
		expect(resolveThoughtLevel("xhigh", opts)).toBe("high");
		expect(resolveThoughtLevel("max", opts)).toBe("high");
		expect(resolveThoughtLevel("low", [{ id: "model", currentValue: "gpt-oss-120b-medium" }])).toBeUndefined();
		expect(resolveThoughtLevel("low", [{ id: "thought_level", options: [] }])).toBeUndefined();
		expect(resolveThoughtLevel("low", undefined)).toBe("low");
	});

	it("parses valid JSON replies with agy_p ids and rejects unknown tools or non-object arguments", () => {
		const tools = [{ name: "read", description: "r", parameters: Type.Object({ path: Type.String() }) }];
		const parsed = parseAgyReply('{"text":"ok","tool_calls":[{"name":"read","arguments":{"path":"x"}}]}', tools);
		expect(parsed?.text).toBe("ok");
		expect(parsed?.calls[0]).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "x" } });
		expect(parsed?.calls[0]?.id).toMatch(/^agy_p_/);
		expect(parseAgyReply('{"text":"ok","tool_calls":[{"name":"unknown","arguments":{}}]}', tools)).toBeUndefined();
		expect(parseAgyReply('{"text":"ok","tool_calls":[{"name":"read","arguments":[1,2]}]}', tools)).toBeUndefined();
		expect(parseAgyReply("plain text", tools)).toBeUndefined();
	});
});
