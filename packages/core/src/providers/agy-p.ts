import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	getCurrentSystemPrompt,
	getCurrentTools,
	type JsonObject,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { type PromptPart, renderTranscriptParts } from "./claude-p.ts";
import { parseReply } from "./kiro-p.ts";
import { ReplyTextExtractor } from "./reply-text.ts";

/** Provider id: models are referenced as `agy-p/<model>`, e.g. `agy-p/gemini-4-neon` or `agy-p/claude-sonnet-5-5`. */
export const AGY_P_PROVIDER = "agy-p";
const AGY_P_API = "agy-p";
/** Environment variable naming the Antigravity CLI executable; `agy` on the PATH otherwise. */
export const AGY_P_COMMAND_ENV = "NEXO_AGY_P_COMMAND";
/** Environment variable overriding how long a turn may stay silent before it is cancelled (milliseconds). */
export const AGY_P_IDLE_ENV = "NEXO_AGY_P_IDLE_MS";

const IDLE_MS_DEFAULT = 120_000;
/** How long a cancelled turn gets to settle before the whole process is considered stuck and killed. */
const CANCEL_GRACE_MS = 5_000;
const AGENT_NAME = "nexo";

/** `thought_level` values in ascending order; pi's `minimal` maps to `low`, and `max` maps to the model's highest level. */
const THOUGHT_LEVELS = ["low", "medium", "high", "xhigh"] as const;

/** One `agy acp` launch: the arguments after the executable and the working directory. */
export interface AgyPRequest {
	args: string[];
	cwd: string;
}

/** A running ACP server: newline-delimited JSON-RPC over its stdio. */
export interface AgyPProcess {
	/** Sends one JSON-RPC message (no trailing newline). */
	write(line: string): void;
	/** Lines the server writes to stdout. */
	lines: AsyncIterable<string>;
	exit: Promise<{ code: number | null; stderr: string }>;
	/** Stops the process and its helpers. */
	kill(): void;
	/** Keeps the host alive while a request is in flight (`true`), or lets it exit while the server is idle (`false`). */
	hold?(on: boolean): void;
}

export type AgyPRunner = (request: AgyPRequest) => AgyPProcess;

export interface AgyPProviderOptions {
	/** Executable to run; defaults to `$NEXO_AGY_P_COMMAND`, then `agy`. */
	command?: string;
	/** Replaces process spawning (tests). */
	run?: AgyPRunner;
}

const isWindows = process.platform === "win32";
const liveGroups = new Set<number>();
const liveDirs = new Set<string>();
let exitHandlerRegistered = false;

function registerExitHandler(): void {
	if (exitHandlerRegistered) return;
	exitHandlerRegistered = true;
	process.on("exit", () => {
		for (const pgid of liveGroups) {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				// the process group already exited
			}
		}
		for (const dir of liveDirs) rmSync(dir, { recursive: true, force: true });
	});
}

function killGroup(child: ChildProcess): void {
	try {
		if (!isWindows && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		// the process group already exited
	}
}

/** Spawns the server in its own process group; the pipes are unref'd so an idle server never keeps the host alive. */
function spawnRunner(command: string): AgyPRunner {
	return ({ args, cwd }) => {
		registerExitHandler();
		const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: !isWindows });
		const pgid = child.pid;
		if (pgid !== undefined && !isWindows) liveGroups.add(pgid);

		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < 16_384) stderr += chunk;
		});
		child.stdin.on("error", () => {});
		const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => {
			child.on("error", (error) => {
				if (pgid !== undefined) liveGroups.delete(pgid);
				resolve({ code: null, stderr: stderr || error.message });
			});
			child.on("close", (code) => {
				if (pgid !== undefined) liveGroups.delete(pgid);
				resolve({ code, stderr });
			});
		});
		return {
			write: (line) => {
				child.stdin.write(`${line}\n`);
			},
			lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
			exit,
			kill: () => killGroup(child),
			hold: (on) => {
				const method = on ? "ref" : "unref";
				child[method]();
				for (const s of [child.stdin, child.stdout, child.stderr]) (s as unknown as Record<string, (() => void) | undefined>)[method]?.();
			},
		};
	};
}

/**
 * Antigravity CLI base model ids (the `model` config option in `agy acp`), paired with display name, context window and
 * reasoning support. Effort maps to ACP's `thought_level` option. Antigravity uses account quota rather than API
 * billing, so cost stays zero.
 */
const AGY_MODELS: readonly (readonly [id: string, displayName: string, contextWindow: number, reasoning: boolean])[] = [
	["gemini-4-neon", "Gemini 4 Neon", 1_048_576, true],
	["gemini-4-carbon", "Gemini 4 Carbon", 1_048_576, true],
	["gemini-4-argon", "Gemini 4 Argon", 1_048_576, true],
	["gemini-4-hydrogen", "Gemini 4 Hydrogen", 1_048_576, true],
	["gemini-3.8-flash", "Gemini 3.8 Flash", 1_048_576, true],
	["gemini-pro-orchestrator-neon", "Orchestrator (Neon)", 1_048_576, false],
	["gemini-pro-orchestrator", "Orchestrator (Carbon)", 1_048_576, false],
	["gemini-pro-orchestrator-argon", "Orchestrator (Argon)", 1_048_576, false],
	["claude-opus-5-5", "Claude Opus 5.5", 1_000_000, true],
	["claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, true],
	["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", 128_000, false],
];

/** Antigravity's base models, borrowing `maxTokens` from pi-ai's Google/Anthropic catalog where an entry matches. */
function agyPModels(): Model<string>[] {
	const builtin = new Map<string, Model<string>>();
	for (const provider of ["google", "anthropic"] as const) {
		for (const m of getBuiltinModels(provider)) builtin.set(m.id, m);
	}
	return AGY_MODELS.map(([id, displayName, contextWindow, reasoning]) => {
		const base = builtin.get(id);
		return {
			...(base ?? { maxTokens: id.startsWith("gemini-") ? 65_536 : 32_000 }),
			id,
			name: `${displayName} (agy)`,
			api: AGY_P_API,
			provider: AGY_P_PROVIDER,
			baseUrl: "",
			reasoning,
			input: ["text", "image"],
			contextWindow,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		} as Model<string>;
	});
}

function plainSchema(tool: Tool): JsonObject {
	return JSON.parse(JSON.stringify(tool.parameters)) as JsonObject;
}

/**
 * System-prompt section describing the tools and the JSON reply format. `agy acp` has no structured-output flag, so the
 * format is asked for here and parsed by `parseAgyReply`.
 */
export function agyToolsSection(tools: readonly Tool[]): string {
	const defs = tools.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: plainSchema(t) })).join("\n");
	return [
		"# Actions",
		"",
		'Every reply must be exactly one JSON object and nothing else (no prose around it, no code fence): {"text": string, "tool_calls": [{"name": string, "arguments": object}]}.',
		"`text` is what you say to the user (may be empty). `tool_calls` lists actions for the caller to run now, with arguments matching the action's parameters.",
		"The actions below are not tools you can invoke: never call them directly and never invoke any native or built-in tool (`call_mcp_tool`, `list_resources`, `read_resource`, `manage_task`, etc.). These actions are NOT MCP tools — only list them in the JSON `tool_calls` array. The caller runs them and sends the results back in the next turn as <tool_result> entries. When you are finished, leave `tool_calls` empty and put the final answer in `text`.",
		"",
		"Available actions, one JSON definition per line:",
		defs,
	].join("\n");
}

let callSeq = 0;
function toolCallId(): string {
	callSeq = (callSeq + 1) % 1_000_000;
	return `agy_p_${Date.now().toString(36)}_${callSeq}`;
}

/** Parses a tools-turn reply using `parseReply`, assigning `agy_p_*` tool call ids. */
export function parseAgyReply(raw: string, tools: readonly Tool[]): { text: string; calls: ToolCall[] } | undefined {
	const parsed = parseReply(raw, tools);
	if (!parsed) return undefined;
	return { text: parsed.text, calls: parsed.calls.map((c) => ({ ...c, id: toolCallId() })) };
}

interface ConfigOption {
	id?: string;
	currentValue?: string;
	options?: { value: string }[];
}

/**
 * Maps nexo's reasoning effort to a `thought_level` value accepted by the active model. When the server reports
 * `configOptions`, models without a `thought_level` option skip it, `max`/`xhigh` clamp to the model's highest level,
 * and an already-active level is skipped.
 */
export function resolveThoughtLevel(reasoning: SimpleStreamOptions["reasoning"], configOptions?: readonly ConfigOption[]): string | undefined {
	if (!reasoning) return undefined;
	const mapped = reasoning === "minimal" ? "low" : reasoning === "max" ? "xhigh" : reasoning;
	if (!(THOUGHT_LEVELS as readonly string[]).includes(mapped)) return undefined;
	if (configOptions === undefined) return mapped;
	const opt = configOptions.find((c) => c.id === "thought_level");
	const values = Array.isArray(opt?.options) ? opt.options.map((o) => o?.value).filter((v): v is string => typeof v === "string") : [];
	if (values.length === 0) return undefined;
	let target: string | undefined;
	if (values.includes(mapped)) target = mapped;
	else if (mapped === "xhigh") target = [...THOUGHT_LEVELS].reverse().find((v) => values.includes(v));
	else return undefined;
	return target && target !== opt?.currentValue ? target : undefined;
}

interface AgyUsage {
	inputTokens?: unknown;
	outputTokens?: unknown;
	cachedReadTokens?: unknown;
	cachedWriteTokens?: unknown;
	thoughtTokens?: unknown;
	totalTokens?: unknown;
}

function finiteNonNeg(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** `agy acp` reports `inputTokens` inclusive of cached tokens (and `outputTokens` inclusive of `thoughtTokens`); cost stays $0. */
function toUsage(u: AgyUsage | undefined): Usage {
	if (!u || typeof u !== "object") return emptyUsage();
	const cacheRead = finiteNonNeg(u.cachedReadTokens);
	const cacheWrite = finiteNonNeg(u.cachedWriteTokens);
	const input = Math.max(0, finiteNonNeg(u.inputTokens) - cacheRead - cacheWrite);
	const output = finiteNonNeg(u.outputTokens);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function parseIdleMs(raw: string | undefined): number {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : IDLE_MS_DEFAULT;
}

/** Formats a JSON-RPC error object, including `data` details when they add context beyond `message`. */
function rpcErrorMessage(error: { code?: number; message?: string; data?: unknown }): string {
	const base = error.message?.trim() || `error ${error.code ?? ""}`.trim();
	const data = error.data;
	let detail = "";
	if (typeof data === "string") detail = data.trim();
	else if (data && typeof data === "object") {
		const obj = data as { details?: unknown; message?: unknown };
		if (typeof obj.details === "string") detail = obj.details.trim();
		else if (typeof obj.message === "string") detail = obj.message.trim();
		else {
			try {
				detail = JSON.stringify(data);
			} catch {
				detail = "";
			}
		}
	}
	return detail && !base.includes(detail) ? `${base}: ${detail}` : base;
}

interface AcpUpdate {
	sessionUpdate?: string;
	toolCallId?: string;
	name?: string;
	title?: string;
	args?: unknown;
	rawInput?: unknown;
	content?: { type?: string; text?: string };
}

function parseObjectArgs(value: unknown): JsonObject | undefined {
	if (value === undefined || value === null) return {};
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
}

/**
 * Extracts a nexo `ToolCall` when a model invokes Antigravity's residual `call_mcp_tool` targeting one of nexo's own
 * declared actions (e.g. `ToolName: "bash"`). Returns undefined for any non-nexo tool or malformed arguments so real
 * MCP tools and other native tools are always rejected.
 */
export function extractMcpToolCall(update: AcpUpdate, knownTools: ReadonlySet<string>): ToolCall | undefined {
	if (update.name !== "call_mcp_tool") return undefined;
	const raw = update.args ?? update.rawInput;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as { ToolName?: unknown; toolName?: unknown; Arguments?: unknown; arguments?: unknown };
	const toolName = typeof obj.ToolName === "string" ? obj.ToolName : typeof obj.toolName === "string" ? obj.toolName : undefined;
	if (!toolName || !knownTools.has(toolName)) return undefined;
	const args = parseObjectArgs(obj.Arguments ?? obj.arguments);
	if (!args) return undefined;
	return { type: "toolCall", id: toolCallId(), name: toolName, arguments: args };
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	keepAlive: boolean;
}

const AGENT_FILE = [
	"---",
	`name: ${AGENT_NAME}`,
	"description: nexo model turn",
	"tools: []",
	"mainAgent: true",
	"---",
	"Follow the instructions provided for this session. Never invoke any native or built-in tools (including `call_mcp_tool`, `list_resources`, `read_resource`, and `manage_task`).",
	"Your own working directory is an empty scratch directory unrelated to the caller's. Never resolve or link file paths against it: use relative paths as given, or only absolute paths named in the conversation.",
	"",
].join("\n");

/**
 * One long-lived `agy acp` server running a minimal custom agent with `tools: []` in a throwaway workspace. Requests
 * are matched to responses by id, session updates are routed by session id, and every pending request fails at once
 * when the process goes away.
 */
class AcpConnection {
	closed = false;
	readonly dir: string;
	private nextId = 0;
	private heldCount = 0;
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Map<string, (update: AcpUpdate) => void>();
	private readonly proc: AgyPProcess;
	private readonly onClose: () => void;

	private constructor(proc: AgyPProcess, dir: string, onClose: () => void) {
		this.proc = proc;
		this.dir = dir;
		this.onClose = onClose;
	}

	/** Starts the server and completes the `initialize` handshake. */
	static async open(run: AgyPRunner, onClose: () => void): Promise<AcpConnection> {
		registerExitHandler();
		// Throwaway workspace holding the no-tools custom agent under ./.agents/agents, with no project files in reach.
		const dir = await mkdtemp(join(tmpdir(), "nexo-agy-p-"));
		liveDirs.add(dir);
		await mkdir(join(dir, ".agents", "agents"), { recursive: true });
		await writeFile(join(dir, ".agents", "agents", `${AGENT_NAME}.md`), AGENT_FILE, "utf8");
		const proc = run({ args: ["acp", "--agent", AGENT_NAME, "--include-default-customizations=false"], cwd: dir });
		const conn = new AcpConnection(proc, dir, onClose);
		void conn.pump();
		void proc.exit.then((exit) => conn.shutdown(new Error(exit.stderr.trim().split("\n").at(-1) || `agy exited with code ${exit.code ?? "null"}`)));
		try {
			await conn.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "nexo", version: "0" } });
		} catch (error) {
			conn.shutdown(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
		return conn;
	}

	private async pump(): Promise<void> {
		try {
			for await (const line of this.proc.lines) this.handle(line);
		} catch {
			// the stream was torn down with the process
		}
		this.shutdown(new Error("agy closed its output"));
	}

	private handle(line: string): void {
		if (!line.trim()) return;
		let m: { id?: number | string | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		if (!m || typeof m !== "object") return;
		if (m.id !== undefined && m.id !== null && m.method) {
			// Agent-to-client request: refuse permissions and error on the rest, so the agent never waits.
			if (m.method === "session/request_permission") {
				const rawOptions = m.params?.options;
				const options = Array.isArray(rawOptions) ? (rawOptions as { optionId?: unknown; kind?: unknown }[]) : [];
				const pick =
					options.find((o) => typeof o?.optionId === "string" && o.kind === "reject_once") ??
					options.find((o) => typeof o?.optionId === "string" && o.kind === "reject_always");
				this.send({ id: m.id, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
			} else this.send({ id: m.id, error: { code: -32601, message: "Method not found" } });
		} else if (m.id !== undefined && m.id !== null) {
			const id = Number(m.id);
			const p = this.pending.get(id);
			if (!p) return;
			this.settle(id, p);
			if (m.error) p.reject(new Error(rpcErrorMessage(m.error)));
			else p.resolve(m.result);
		} else if (m.method === "session/update") {
			const sessionId = m.params?.sessionId;
			const update = m.params?.update;
			if (typeof sessionId === "string" && update && typeof update === "object") this.listeners.get(sessionId)?.(update as AcpUpdate);
		}
	}

	private send(message: object): void {
		try {
			this.proc.write(JSON.stringify({ jsonrpc: "2.0", ...message }));
		} catch {
			// a dead process is reported through exit
		}
	}

	private settle(id: number, entry: Pending): void {
		this.pending.delete(id);
		if (entry.keepAlive) {
			this.heldCount = Math.max(0, this.heldCount - 1);
			// Idle server: let the host exit (the exit handler kills the server); foreground requests keep the host alive.
			if (this.heldCount === 0 && !this.closed) this.proc.hold?.(false);
		}
	}

	request(method: string, params: object, keepAlive = true): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("agy is not running"));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			if (keepAlive) {
				if (this.heldCount === 0) this.proc.hold?.(true);
				this.heldCount++;
			}
			this.pending.set(id, { resolve, reject, keepAlive });
			this.send({ id, method, params });
		});
	}

	notify(method: string, params: object): void {
		this.send({ method, params });
	}

	listen(sessionId: string, fn: (update: AcpUpdate) => void): void {
		this.listeners.set(sessionId, fn);
	}

	unlisten(sessionId: string): void {
		this.listeners.delete(sessionId);
	}

	/** Fails everything in flight, stops the process and removes the workspace. Safe to call more than once. */
	shutdown(reason: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.heldCount = 0;
		this.onClose();
		for (const p of this.pending.values()) p.reject(reason);
		this.pending.clear();
		this.listeners.clear();
		this.proc.kill();
		liveDirs.delete(this.dir);
		void rm(this.dir, { recursive: true, force: true }).catch(() => {});
	}
}

interface Session {
	conn: AcpConnection;
	id: string;
}

interface RunOutcome {
	text: string;
	recoveredCalls: ToolCall[];
	stopReason?: string;
	usage: Usage;
	error?: string;
	/** The server went away mid-turn (as opposed to the turn failing). */
	lost?: boolean;
	aborted?: boolean;
}

/** Why a tools turn ended without a usable reply; the engine retries it a few times (see `isFormatFailure`). */
export const AGY_P_BAD_REPLY = "reply was not a JSON object in the required format";

/** True when a reply that did not parse was an attempt at the JSON format rather than a plain-prose answer. */
function looksLikeReplyAttempt(text: string): boolean {
	return /"tool_calls"\s*:/.test(text) || /^\s*(```|\{)/.test(text);
}

const RETRY_NOTE = "Your previous reply was not a single valid JSON object in the required format. Reply again with only that JSON object.";

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | "aborted"> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.resolve("aborted");
	let onAbort!: () => void;
	const aborted = new Promise<"aborted">((resolve) => {
		onAbort = () => resolve("aborted");
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([promise, aborted]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

function streamAgyP(
	getConn: () => Promise<AcpConnection>,
	model: Model<string>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	const snapshot = (): AssistantMessage => ({ ...partial, content: [...partial.content] });
	const fail = (reason: "error" | "aborted", message: string, usage?: Usage): void => {
		const error: AssistantMessage = { ...snapshot(), stopReason: reason, errorMessage: message, ...(usage ? { usage } : {}) };
		stream.push({ type: "error", reason, error });
		stream.end(error);
	};
	const emitText = (text: string): void => {
		const contentIndex = partial.content.length;
		partial.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex, partial: snapshot() });
		(partial.content[contentIndex] as TextContent).text = text;
		stream.push({ type: "text_delta", contentIndex, delta: text, partial: snapshot() });
		stream.push({ type: "text_end", contentIndex, content: text, partial: snapshot() });
	};

	queueMicrotask(async () => {
		const signal = options?.signal;
		if (signal?.aborted) return fail("aborted", "Request was aborted");
		const tools = getCurrentTools(context.messages);
		const useTools = tools.length > 0 && options?.toolChoice !== "none";
		const knownTools = useTools ? new Set(tools.map((t) => t.name)) : new Set<string>();
		const systemPrompt = [getCurrentSystemPrompt(context.messages), useTools ? agyToolsSection(tools) : ""].filter((s) => s.length > 0).join("\n\n");
		const idleMs = parseIdleMs(process.env[AGY_P_IDLE_ENV]);

		const closeSession = (session: Session | undefined): void => {
			if (!session || session.conn.closed) return;
			// Non-blocking cleanup: never keep the host alive waiting for `session/close`.
			void session.conn.request("session/close", { sessionId: session.id }, false).catch(() => {});
		};

		/** Opens one session on the shared server, retrying once if a reused server died during setup. */
		const openSessionOnce = async (): Promise<{ session?: Session; lost?: boolean; aborted?: boolean }> => {
			const connRes = await raceAbort(getConn(), signal);
			if (connRes === "aborted") return { aborted: true };
			const conn = connRes;
			let sessionId: string | undefined;
			try {
				const createdRes = await raceAbort(
					conn.request("session/new", {
						cwd: conn.dir,
						mcpServers: [],
						...(systemPrompt ? { _meta: { antigravity: { systemPrompt: { append: systemPrompt } } } } : {}),
					}),
					signal,
				);
				if (createdRes === "aborted") return { aborted: true };
				const created = createdRes as { sessionId?: unknown; configOptions?: ConfigOption[] } | undefined;
				if (typeof created?.sessionId !== "string" || !created.sessionId) throw new Error("session/new returned no sessionId");
				sessionId = created.sessionId;
				const modelRes = await raceAbort(
					conn.request("session/set_config_option", { sessionId, configId: "model", value: model.id }),
					signal,
				);
				if (modelRes === "aborted") {
					closeSession({ conn, id: sessionId });
					return { aborted: true };
				}
				const modelOpts = (modelRes as { configOptions?: ConfigOption[] } | undefined)?.configOptions;
				const level = resolveThoughtLevel(options?.reasoning, modelOpts ?? created.configOptions);
				if (level) {
					const levelRes = await raceAbort(
						conn.request("session/set_config_option", { sessionId, configId: "thought_level", value: level }),
						signal,
					);
					if (levelRes === "aborted") {
						closeSession({ conn, id: sessionId });
						return { aborted: true };
					}
				}
				return { session: { conn, id: sessionId } };
			} catch (error) {
				if (sessionId) closeSession({ conn, id: sessionId });
				if (conn.closed) return { lost: true };
				throw error;
			}
		};

		const startSession = async (allowRetry = true): Promise<Session | "aborted"> => {
			const first = await openSessionOnce();
			if (first.aborted) return "aborted";
			if (first.session) return first.session;
			if (first.lost && allowRetry && !signal?.aborted) {
				const second = await openSessionOnce();
				if (second.aborted) return "aborted";
				if (second.session) return second.session;
			}
			throw new Error("agy closed before session could start");
		};

		/**
		 * One prompt on a session. Thinking and text stream into `partial` as they arrive; on a tools turn the text shown
		 * is the reply's `text` field, read out of the JSON while it is still being written (`streamText` off: none).
		 */
		const runOnce = async (session: Session, input: string | readonly PromptPart[], streamText = true): Promise<RunOutcome> => {
			// ACP content blocks: text, and images as base64 (`agy acp` advertises promptCapabilities.image).
			const prompt =
				typeof input === "string"
					? [{ type: "text", text: input }]
					: input.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image", data: p.data, mimeType: p.mimeType }));
			const { conn, id } = session;
			const outcome: RunOutcome = { text: "", recoveredCalls: [], usage: emptyUsage() };
			const replyText = useTools ? new ReplyTextExtractor() : undefined;
			// Any native tool call cancels the turn; `call_mcp_tool` targeting a known nexo action is recovered as a nexo ToolCall.
			let nativeCall: string | undefined;
			let cancelledForTool = false;
			const seenCallIds = new Set<string>();
			let stalled = false;
			let open: { kind: "text" | "thinking"; index: number } | undefined;
			let idle: NodeJS.Timeout | undefined;
			let killTimer: NodeJS.Timeout | undefined;
			const cancel = () => conn.notify("session/cancel", { sessionId: id });
			const arm = () => {
				clearTimeout(idle);
				idle = setTimeout(() => {
					stalled = true;
					cancel();
					killTimer = setTimeout(() => conn.shutdown(new Error("agy did not answer the cancel")), CANCEL_GRACE_MS);
				}, idleMs);
			};
			const close = (): void => {
				if (!open) return;
				const block = partial.content[open.index];
				if (block?.type === "text") stream.push({ type: "text_end", contentIndex: open.index, content: block.text, partial: snapshot() });
				else if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: open.index, content: (block as ThinkingContent).thinking, partial: snapshot() });
				open = undefined;
			};
			conn.listen(id, (u) => {
				arm();
				if (u.sessionUpdate === "tool_call") {
					if (typeof u.toolCallId === "string") {
						if (seenCallIds.has(u.toolCallId)) return;
						seenCallIds.add(u.toolCallId);
					}
					const recovered = useTools ? extractMcpToolCall(u, knownTools) : undefined;
					if (recovered) {
						outcome.recoveredCalls.push(recovered);
					} else if (!nativeCall) {
						nativeCall = u.title ?? u.name ?? "tool";
					}
					if (!cancelledForTool) {
						cancelledForTool = true;
						cancel();
					}
					return;
				}
				const kind = u.sessionUpdate === "agent_message_chunk" ? "text" : u.sessionUpdate === "agent_thought_chunk" ? "thinking" : undefined;
				const chunk = u.content?.type === "text" ? u.content.text : undefined;
				if (!kind || !chunk) return;
				if (kind === "text") outcome.text += chunk;
				const delta = kind === "text" && replyText ? (streamText ? replyText.push(chunk) : "") : chunk;
				if (!delta) return;
				if (open?.kind !== kind) {
					close();
					open = { kind, index: partial.content.length };
					partial.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
					stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: open.index, partial: snapshot() });
				}
				const block = partial.content[open.index]!;
				if (block.type === "text") block.text += delta;
				else if (block.type === "thinking") block.thinking += delta;
				stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: open.index, delta, partial: snapshot() });
			});

			let abort!: () => void;
			const aborted = new Promise<"aborted">((resolve) => {
				abort = () => resolve("aborted");
			});
			const onAbort = () => {
				cancel();
				abort();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			arm();
			try {
				const settled = await Promise.race([
					conn.request("session/prompt", { sessionId: id, prompt }).then(
						(r) => ({ r: r as { stopReason?: string; usage?: AgyUsage } | undefined }),
						(e: Error) => ({ e }),
					),
					aborted,
				]);
				close();
				if (settled === "aborted") outcome.aborted = true;
				else if (stalled) outcome.error = `no output for ${Math.round(idleMs / 1000)}s`;
				else if (nativeCall) outcome.error = `stopped: native tool call "${nativeCall}" (the nexo agent offers no tools)`;
				else if (outcome.recoveredCalls.length > 0) {
					if (!("e" in settled)) outcome.usage = toUsage(settled.r?.usage);
				} else if ("e" in settled) {
					outcome.error = settled.e.message;
					outcome.lost = conn.closed;
				} else {
					outcome.stopReason = settled.r?.stopReason;
					outcome.usage = toUsage(settled.r?.usage);
					if (outcome.stopReason === "cancelled") outcome.error = "run cancelled";
				}
			} finally {
				clearTimeout(idle);
				clearTimeout(killTimer);
				conn.unlisten(id);
				signal?.removeEventListener("abort", onAbort);
			}
			return outcome;
		};

		let session: Session | undefined;
		try {
			stream.push({ type: "start", partial: snapshot() });

			const prompt = renderTranscriptParts(context.messages);
			const opened = await startSession();
			if (opened === "aborted" || signal?.aborted) return fail("aborted", "Request was aborted");
			session = opened;
			let outcome = await runOnce(session, prompt);
			// The shared server died under this turn before anything streamed: start a fresh one and run it again, once.
			if (outcome.lost && !signal?.aborted && partial.content.length === 0) {
				const reopened = await startSession(false);
				if (reopened === "aborted" || signal?.aborted) return fail("aborted", "Request was aborted");
				session = reopened;
				outcome = await runOnce(session, prompt);
			}
			let usage = outcome.usage;
			if (outcome.aborted || signal?.aborted) return fail("aborted", "Request was aborted", usage);
			if (outcome.error) return fail("error", `agy failed: ${outcome.error}`, usage);

			let stopReason: "stop" | "length" | "toolUse" = outcome.stopReason === "max_tokens" ? "length" : "stop";
			if (useTools) {
				const fromOutcome = (o: RunOutcome): { text: string; calls: ToolCall[] } | undefined =>
					o.recoveredCalls.length > 0
						? { text: looksLikeReplyAttempt(o.text) ? "" : o.text.trim(), calls: o.recoveredCalls }
						: parseAgyReply(o.text, tools);
				let reply = fromOutcome(outcome);
				if (!reply) {
					// Same session, so the model still has the transcript: only the correction is sent. Text the first
					// attempt already streamed is not streamed again.
					outcome = await runOnce(session, RETRY_NOTE, !partial.content.some((b) => b.type === "text"));
					usage = addUsage(usage, outcome.usage);
					if (outcome.aborted || signal?.aborted) return fail("aborted", "Request was aborted", usage);
					if (outcome.error) return fail("error", `agy failed: ${outcome.error}`, usage);
					reply = fromOutcome(outcome);
				}
				// Still not the format. A botched attempt at it (JSON naming an unknown action, a truncated object) is an
				// error the engine retries; plain prose is kept.
				if (!reply && looksLikeReplyAttempt(outcome.text)) return fail("error", `agy failed: ${AGY_P_BAD_REPLY}`, usage);
				const { text, calls } = reply ?? { text: outcome.text, calls: [] };
				// The parsed reply is the answer. Text that streamed is normally the same; where it is not, the block takes it.
				const streamed = partial.content.findIndex((b) => b.type === "text");
				if (streamed < 0) {
					if (text) emitText(text);
				} else if (text) (partial.content[streamed] as TextContent).text = text;
				else partial.content.splice(streamed, 1);
				for (const call of calls) {
					const contentIndex = partial.content.length;
					partial.content.push({ ...call, arguments: {} });
					stream.push({ type: "toolcall_start", contentIndex, partial: snapshot() });
					partial.content[contentIndex] = call;
					stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: snapshot() });
					stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: snapshot() });
				}
				stopReason = calls.length > 0 ? "toolUse" : "stop";
			} else if (!partial.content.some((b) => b.type === "text") && outcome.text) {
				emitText(outcome.text);
			}
			const message: AssistantMessage = { ...snapshot(), usage, stopReason };
			stream.push({ type: "done", reason: stopReason, message });
			stream.end(message);
		} catch (error) {
			if (signal?.aborted) return fail("aborted", "Request was aborted");
			fail("error", `agy failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			closeSession(session);
		}
	});
	return stream;
}

/**
 * Runs models through one long-lived Antigravity CLI ACP server (`agy acp`), authenticated by the CLI's own login.
 * The server starts on the first call and is shared by every call after it, avoiding per-call language-server start-up.
 * It runs a minimal custom agent with `tools: []` in a throwaway workspace; each turn opens a fresh session carrying
 * nexo's system prompt via `_meta.antigravity.systemPrompt.append`, sets the base model and `thought_level` from
 * reasoning effort, and closes the session afterwards. Any native tool call cancels the turn. Nexo tools are described
 * in the prompt and parsed as `{ text, tool_calls }` (one correction retry when it does not parse); `text` streams as
 * it is written. Token counts are reported from ACP usage while cost stays $0.
 */
export function agyPProvider(options: AgyPProviderOptions = {}): Provider {
	const run = options.run ?? spawnRunner(options.command ?? process.env[AGY_P_COMMAND_ENV] ?? "agy");
	let current: Promise<AcpConnection> | undefined;
	const getConn = (): Promise<AcpConnection> => {
		if (current) return current;
		const opened: Promise<AcpConnection> = AcpConnection.open(run, () => {
			if (current === opened) current = undefined;
		});
		current = opened;
		opened.catch(() => {
			if (current === opened) current = undefined;
		});
		return opened;
	};
	const api = {
		stream: (model: Model<string>, context: TranscriptContext, opts?: SimpleStreamOptions) => streamAgyP(getConn, model, context, opts),
		streamSimple: (model: Model<string>, context: TranscriptContext, opts?: SimpleStreamOptions) => streamAgyP(getConn, model, context, opts),
	};
	return createProvider({
		id: AGY_P_PROVIDER,
		name: "Antigravity CLI (agy acp)",
		auth: {
			apiKey: {
				name: "Antigravity CLI login",
				resolve: async () => ({ auth: {}, source: "agy CLI login" }),
			},
		},
		models: agyPModels(),
		api,
	});
}
