import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { renderTranscript } from "./claude-p.ts";

/** Provider id: models are referenced as `kiro-p/<kiro model id>`, e.g. `kiro-p/claude-sonnet-5.5` or `kiro-p/auto`. */
export const KIRO_P_PROVIDER = "kiro-p";
const KIRO_P_API = "kiro-p";
/** Environment variable naming the Kiro CLI executable; `kiro-cli` on the PATH otherwise. */
export const KIRO_P_COMMAND_ENV = "NEXO_KIRO_P_COMMAND";
/** Environment variable overriding how long a turn may stay silent before it is cancelled (milliseconds). */
export const KIRO_P_IDLE_ENV = "NEXO_KIRO_P_IDLE_MS";

const IDLE_MS_DEFAULT = 120_000;
/** How long a cancelled turn gets to settle before the whole process is considered stuck and killed. */
const CANCEL_GRACE_MS = 5_000;

/** `effortLevel` values; pi's `minimal` maps to `low`. */
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** One `kiro-cli acp` launch: the arguments after the executable and the working directory. */
export interface KiroPRequest {
	args: string[];
	cwd: string;
}

/** A running ACP server: newline-delimited JSON-RPC over its stdio. */
export interface KiroPProcess {
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

export type KiroPRunner = (request: KiroPRequest) => KiroPProcess;

export interface KiroPProviderOptions {
	/** Executable to run; defaults to `$NEXO_KIRO_P_COMMAND`, then `kiro-cli`. */
	command?: string;
	/** Replaces process spawning (tests). */
	run?: KiroPRunner;
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
function spawnRunner(command: string): KiroPRunner {
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

/** Kiro's model ids (`kiro-cli chat --list-models`) with their context windows. Kiro bills in credits, so cost stays zero. */
const KIRO_MODELS: readonly (readonly [id: string, contextWindow: number])[] = [
	["auto", 1_000_000],
	["claude-opus-5.5", 1_000_000],
	["claude-sonnet-5.5", 1_000_000],
	["claude-opus-5", 1_000_000],
	["claude-sonnet-5", 1_000_000],
	["claude-opus-4.8", 1_000_000],
	["claude-opus-4.7", 1_000_000],
	["claude-opus-4.6", 1_000_000],
	["claude-sonnet-4.6", 1_000_000],
	["claude-opus-4.5", 200_000],
	["claude-sonnet-4.5", 200_000],
	["claude-haiku-4.5", 200_000],
	["gpt-5.6-sol", 1_000_000],
	["gpt-5.6-terra", 1_000_000],
	["gpt-5.6-luna", 1_000_000],
	["deepseek-3.2", 164_000],
	["minimax-m2.5", 196_000],
	["minimax-m2.1", 196_000],
	["glm-5", 200_000],
	["qwen3-coder-next", 256_000],
];

/** Kiro's models, borrowing pi-ai's Anthropic catalog entry (by `claude-x-5.5` → `claude-x-5-5`) where there is one. */
function kiroPModels(): Model<string>[] {
	const anthropic = new Map(getBuiltinModels("anthropic").map((m) => [m.id, m]));
	return KIRO_MODELS.map(([id, contextWindow]) => {
		const base = anthropic.get(id.replace(/\./g, "-"));
		return {
			...(base ?? { reasoning: id.startsWith("claude-") || id === "auto", maxTokens: 32_000 }),
			id,
			name: `${base?.name ?? id} (kiro-cli)`,
			api: KIRO_P_API,
			provider: KIRO_P_PROVIDER,
			baseUrl: "",
			input: ["text"],
			contextWindow,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		} as Model<string>;
	});
}

function plainSchema(tool: Tool): JsonObject {
	return JSON.parse(JSON.stringify(tool.parameters)) as JsonObject;
}

/**
 * System-prompt section describing the tools and the JSON reply format. Kiro has no structured-output flag, so the
 * format is asked for here and parsed by `parseReply`.
 */
export function kiroToolsSection(tools: readonly Tool[]): string {
	const defs = tools.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: plainSchema(t) })).join("\n");
	return [
		"# Actions",
		"",
		'Every reply must be exactly one JSON object and nothing else (no prose around it, no code fence): {"text": string, "tool_calls": [{"name": string, "arguments": object}]}.',
		"`text` is what you say to the user (may be empty). `tool_calls` lists actions for the caller to run now, with arguments matching the action's parameters.",
		"The actions below are not tools you can invoke: never call them directly, only list them in `tool_calls`. The caller runs them and sends the results back in the next turn as <tool_result> entries. When you are finished, leave `tool_calls` empty and put the final answer in `text`.",
		"",
		"Available actions, one JSON definition per line:",
		defs,
	].join("\n");
}

let callSeq = 0;
function toolCallId(): string {
	callSeq = (callSeq + 1) % 1_000_000;
	return `kiro_p_${Date.now().toString(36)}_${callSeq}`;
}

/** Spans of the top-level `{...}` groups in `raw`, braces inside JSON strings ignored. */
function objectSpans(raw: string): [start: number, end: number][] {
	const spans: [number, number][] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
		} else if (ch === '"' && depth > 0) inString = true;
		else if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}" && depth > 0) {
			depth--;
			if (depth === 0) spans.push([start, i]);
		}
	}
	return spans;
}

type Reply = { text?: unknown; tool_calls?: unknown };

function isReply(value: unknown): value is Reply {
	return typeof value === "object" && value !== null && ("text" in value || "tool_calls" in value);
}

/**
 * Parses a tools-turn reply: the JSON object, tolerating a code fence or stray prose around it. The model sometimes
 * writes the object, corrects itself ("no code fence") and writes it again, so the last object that parses wins.
 * Undefined when there is none.
 */
export function parseReply(raw: string, tools: readonly Tool[]): { text: string; calls: ToolCall[] } | undefined {
	let obj: Reply | undefined;
	for (const [start, end] of objectSpans(raw).reverse()) {
		try {
			const candidate: unknown = JSON.parse(raw.slice(start, end + 1));
			if (isReply(candidate)) {
				obj = candidate;
				break;
			}
		} catch {
			// Not JSON (a brace in prose, or a fenced block the model abandoned): try the previous span.
		}
	}
	if (!obj) return undefined;
	const known = new Set(tools.map((t) => t.name));
	const calls: ToolCall[] = [];
	if (Array.isArray(obj.tool_calls)) {
		for (const c of obj.tool_calls as { name?: unknown; arguments?: unknown }[]) {
			if (typeof c?.name !== "string" || !known.has(c.name)) return undefined;
			const args = typeof c.arguments === "object" && c.arguments !== null && !Array.isArray(c.arguments) ? (c.arguments as JsonObject) : {};
			calls.push({ type: "toolCall", id: toolCallId(), name: c.name, arguments: args });
		}
	}
	return { text: typeof obj.text === "string" ? obj.text : "", calls };
}

function effortFlag(reasoning: SimpleStreamOptions["reasoning"]): string | undefined {
	if (!reasoning) return undefined;
	const effort = reasoning === "minimal" ? "low" : reasoning;
	return EFFORTS.has(effort) ? effort : undefined;
}

/** Kiro reports credits, not tokens, so usage carries no counts and no cost. */
function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

interface AcpUpdate {
	sessionUpdate?: string;
	title?: string;
	content?: { type?: string; text?: string };
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/**
 * One long-lived `kiro-cli acp --agent-engine=v3` server. Requests are matched to responses by id, session updates are
 * routed by session id, and every pending request fails at once when the process goes away.
 */
class AcpConnection {
	closed = false;
	readonly dir: string;
	private nextId = 0;
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Map<string, (update: AcpUpdate) => void>();
	private readonly agents = new Map<string, Promise<void>>();
	private readonly proc: KiroPProcess;
	private readonly onClose: () => void;

	private constructor(proc: KiroPProcess, dir: string, onClose: () => void) {
		this.proc = proc;
		this.dir = dir;
		this.onClose = onClose;
	}

	/** Starts the server and completes the `initialize` handshake. */
	static async open(run: KiroPRunner, onClose: () => void): Promise<AcpConnection> {
		registerExitHandler();
		// The agents live in a throwaway workspace: Kiro finds them under ./.kiro/agents, and no project files are in reach.
		const dir = await mkdtemp(join(tmpdir(), "nexo-kiro-p-"));
		liveDirs.add(dir);
		await mkdir(join(dir, ".kiro", "agents"), { recursive: true });
		const proc = run({ args: ["acp", "--agent-engine=v3"], cwd: dir });
		const conn = new AcpConnection(proc, dir, onClose);
		void conn.pump();
		void proc.exit.then((exit) => conn.shutdown(new Error(exit.stderr.trim().split("\n").at(-1) || `kiro-cli exited with code ${exit.code ?? "null"}`)));
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
		this.shutdown(new Error("kiro-cli closed its output"));
	}

	private handle(line: string): void {
		if (!line.trim()) return;
		let m: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } };
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		if (m.id !== undefined && m.method) {
			// Agent-to-client request: refuse permissions (the agents deny everything anyway) and error on the rest, so the agent never waits.
			if (m.method === "session/request_permission") {
				const options = (m.params?.options ?? []) as { optionId: string; kind?: string }[];
				const pick = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");
				this.send({ id: m.id, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
			} else this.send({ id: m.id, error: { code: -32601, message: "Method not found" } });
		} else if (m.id !== undefined) {
			const p = this.pending.get(Number(m.id));
			if (!p) return;
			this.settle(Number(m.id));
			if (m.error) p.reject(new Error(m.error.message ?? `error ${m.error.code ?? ""}`));
			else p.resolve(m.result);
		} else if (m.method === "session/update") {
			const sessionId = m.params?.sessionId;
			if (typeof sessionId === "string") this.listeners.get(sessionId)?.(m.params?.update as AcpUpdate);
		}
	}

	private send(message: object): void {
		try {
			this.proc.write(JSON.stringify({ jsonrpc: "2.0", ...message }));
		} catch {
			// a dead process is reported through exit
		}
	}

	private settle(id: number): void {
		this.pending.delete(id);
		// Idle server: let the host exit (the exit handler kills the server); a request in flight keeps the host alive.
		if (this.pending.size === 0 && !this.closed) this.proc.hold?.(false);
	}

	request(method: string, params: object): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("kiro-cli is not running"));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			if (this.pending.size === 0) this.proc.hold?.(true);
			this.pending.set(id, { resolve, reject });
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

	/** Writes the agent file for `name` once; later sessions select it with `modeId`. */
	ensureAgent(name: string, prompt: string): Promise<void> {
		let written = this.agents.get(name);
		if (!written) {
			const agent = {
				name,
				description: "nexo model turn",
				prompt,
				tools: [],
				// `tools: []` alone still leaves Kiro's skill tool in the request, which keeps the model in tool-calling mode and
				// makes it call the actions below natively ("Tool X is not available"). Denying every capability empties the
				// request's tool list, so the model cannot emit a tool call at all.
				permissions: { rules: [{ capability: "all", effect: "deny" }] },
				mcpServers: {},
				includeMcpJson: false,
				includePowers: false,
			};
			written = writeFile(join(this.dir, ".kiro", "agents", `${name}.json`), JSON.stringify(agent), "utf8");
			this.agents.set(name, written);
		}
		return written;
	}

	/** Fails everything in flight, stops the process and removes the workspace. Safe to call more than once. */
	shutdown(reason: Error): void {
		if (this.closed) return;
		this.closed = true;
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
	stopReason?: string;
	error?: string;
	/** The server went away mid-turn (as opposed to the turn failing). */
	lost?: boolean;
	aborted?: boolean;
}

const RETRY_NOTE = "Your previous reply was not a single valid JSON object in the required format. Reply again with only that JSON object.";

function streamKiroP(getConn: () => Promise<AcpConnection>, model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
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
	const fail = (reason: "error" | "aborted", message: string): void => {
		const error: AssistantMessage = { ...snapshot(), stopReason: reason, errorMessage: message };
		stream.push({ type: "error", reason, error });
		stream.end(error);
	};
	const pushText = (text: string): void => {
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
		const systemPrompt = [getCurrentSystemPrompt(context.messages), useTools ? kiroToolsSection(tools) : ""].filter((s) => s.length > 0).join("\n\n");
		const agentPrompt = systemPrompt || "You are a helpful assistant.";
		const agentName = `nexo-${createHash("sha256").update(agentPrompt).digest("hex").slice(0, 12)}`;
		const effort = effortFlag(options?.reasoning);
		const idleMs = Number(process.env[KIRO_P_IDLE_ENV]) || IDLE_MS_DEFAULT;

		/** A fresh session on the shared server, running the agent that carries this turn's system prompt. */
		const startSession = async (): Promise<Session> => {
			const conn = await getConn();
			await conn.ensureAgent(agentName, agentPrompt);
			// Kiro notices a new agent file a moment after it is written, and a session created sooner silently runs its
			// default agent (which has tools). Retry a few times until the requested agent is the session's mode.
			let mode: string | undefined;
			for (let attempt = 0; attempt < 5; attempt++) {
				if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
				const res = (await conn.request("session/new", {
					cwd: conn.dir,
					mcpServers: [],
					_meta: { kiro: { modeId: agentName, modelId: model.id, ...(effort ? { effortLevel: effort } : {}) } },
				})) as { sessionId?: string; modes?: { currentModeId?: string } };
				mode = res.modes?.currentModeId;
				if (res.sessionId && mode === agentName) return { conn, id: res.sessionId };
			}
			// Still not applied: refuse to run rather than let the model see Kiro's default tools.
			throw new Error(`stopped: agent "${agentName}" not applied (mode ${mode ?? "none"})`);
		};

		/** One prompt on a session; plain turns stream their text and thinking into `partial` as it arrives. */
		const runOnce = async (session: Session, text: string): Promise<RunOutcome> => {
			const { conn, id } = session;
			const outcome: RunOutcome = { text: "" };
			// A native tool call means the model was offered tools after all; Kiro would answer "not available" and loop.
			let nativeCall: string | undefined;
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
					killTimer = setTimeout(() => conn.shutdown(new Error("kiro-cli did not answer the cancel")), CANCEL_GRACE_MS);
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
					if (!nativeCall) {
						nativeCall = u.title ?? "tool";
						cancel();
					}
					return;
				}
				const kind = u.sessionUpdate === "agent_message_chunk" ? "text" : u.sessionUpdate === "agent_thought_chunk" ? "thinking" : undefined;
				const delta = u.content?.type === "text" ? u.content.text : undefined;
				if (!kind || !delta) return;
				if (kind === "text") outcome.text += delta;
				if (useTools) return;
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
					conn.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] }).then(
						(r) => ({ r: r as { stopReason?: string } | undefined }),
						(e: Error) => ({ e }),
					),
					aborted,
				]);
				close();
				if (settled === "aborted") outcome.aborted = true;
				else if (stalled) outcome.error = `no output for ${Math.round(idleMs / 1000)}s`;
				else if (nativeCall) outcome.error = `stopped: native tool call "${nativeCall}" (the nexo agent offers no tools)`;
				else if ("e" in settled) {
					outcome.error = settled.e.message;
					outcome.lost = conn.closed;
				} else {
					outcome.stopReason = settled.r?.stopReason;
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

		try {
			stream.push({ type: "start", partial: snapshot() });

			const prompt = renderTranscript(context.messages);
			let session = await startSession();
			if (signal?.aborted) return fail("aborted", "Request was aborted");
			let outcome = await runOnce(session, prompt);
			// The shared server died under this turn before anything streamed: start a fresh one and run it again, once.
			if (outcome.lost && !signal?.aborted && partial.content.length === 0) {
				session = await startSession();
				outcome = await runOnce(session, prompt);
			}
			if (outcome.aborted || signal?.aborted) return fail("aborted", "Request was aborted");
			if (outcome.error) return fail("error", `kiro-cli failed: ${outcome.error}`);

			let stopReason: "stop" | "length" | "toolUse" = outcome.stopReason === "max_tokens" ? "length" : "stop";
			if (useTools) {
				let reply = parseReply(outcome.text, tools);
				if (!reply) {
					// Same session, so the model still has the transcript: only the correction is sent.
					outcome = await runOnce(session, RETRY_NOTE);
					if (outcome.aborted || signal?.aborted) return fail("aborted", "Request was aborted");
					if (outcome.error) return fail("error", `kiro-cli failed: ${outcome.error}`);
					reply = parseReply(outcome.text, tools);
				}
				// Still not the JSON format: keep what the model said as a plain answer rather than dropping it.
				const { text, calls } = reply ?? { text: outcome.text, calls: [] };
				if (text) pushText(text);
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
				pushText(outcome.text);
			}
			const message: AssistantMessage = { ...snapshot(), stopReason };
			stream.push({ type: "done", reason: stopReason, message });
			stream.end(message);
		} catch (error) {
			if (signal?.aborted) return fail("aborted", "Request was aborted");
			fail("error", `kiro-cli failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	return stream;
}

/**
 * Runs models through one long-lived Kiro CLI ACP server (`kiro-cli acp --agent-engine=v3`), authenticated by the
 * CLI's own login. The server starts on the first call and is shared by every call after it, which removes the
 * per-call CLI start-up. Each turn is a fresh session whose agent carries the system prompt (one agent file per
 * prompt hash), no tools and a policy denying every capability, so Kiro's request carries no tool at all; a native
 * tool call cancels the turn. Nexo tools are described in the prompt and the reply parsed as `{ text, tool_calls }`
 * (one correction retry when it does not parse), so tool turns arrive whole rather than streamed. A turn silent for
 * `$NEXO_KIRO_P_IDLE_MS` (120s) is cancelled; a server that dies is replaced on the next call, and a turn it dropped
 * is re-run once. Kiro bills in credits and reports no token counts, so usage is empty.
 */
export function kiroPProvider(options: KiroPProviderOptions = {}): Provider {
	const run = options.run ?? spawnRunner(options.command ?? process.env[KIRO_P_COMMAND_ENV] ?? "kiro-cli");
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
		stream: (model: Model<string>, context: TranscriptContext, opts?: SimpleStreamOptions) => streamKiroP(getConn, model, context, opts),
		streamSimple: (model: Model<string>, context: TranscriptContext, opts?: SimpleStreamOptions) => streamKiroP(getConn, model, context, opts),
	};
	return createProvider({
		id: KIRO_P_PROVIDER,
		name: "Kiro CLI (kiro-cli acp)",
		auth: {
			apiKey: {
				name: "Kiro CLI login",
				resolve: async () => ({ auth: {}, source: "kiro-cli login" }),
			},
		},
		models: kiroPModels(),
		api,
	});
}
