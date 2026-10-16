import { spawn } from "node:child_process";
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

/** `kiro-cli chat --effort` values; pi's `minimal` maps to `low`. */
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** One `kiro-cli chat` invocation: the arguments after the executable, the prompt on stdin and the working directory. */
export interface KiroPRequest {
	args: string[];
	stdin: string;
	cwd: string;
	signal?: AbortSignal;
	/** Receives stderr as it arrives, so the caller can stop a run that went wrong before it finishes. */
	onStderr?: (chunk: string) => void;
}

/** A running invocation: its stdout lines and its exit. */
export interface KiroPProcess {
	lines: AsyncIterable<string>;
	exit: Promise<{ code: number | null; stderr: string }>;
}

export type KiroPRunner = (request: KiroPRequest) => KiroPProcess;

export interface KiroPProviderOptions {
	/** Executable to run; defaults to `$NEXO_KIRO_P_COMMAND`, then `kiro-cli`. */
	command?: string;
	/** Replaces process spawning (tests). */
	run?: KiroPRunner;
}

function spawnRunner(command: string): KiroPRunner {
	return ({ args, stdin, cwd, signal, onStderr }) => {
		const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], ...(signal ? { signal } : {}) });
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < 16_384) stderr += chunk;
			onStderr?.(chunk);
		});
		const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => {
			child.on("error", (error) => resolve({ code: null, stderr: stderr || error.message }));
			child.on("close", (code) => resolve({ code, stderr }));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(stdin);
		return { lines: createInterface({ input: child.stdout, crlfDelay: Infinity }), exit };
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

/** Parses a tools-turn reply: the JSON object, tolerating a code fence or stray prose around it. Undefined when there is none. */
export function parseReply(raw: string, tools: readonly Tool[]): { text: string; calls: ToolCall[] } | undefined {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end < start) return undefined;
	let obj: { text?: unknown; tool_calls?: unknown };
	try {
		obj = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof obj !== "object" || obj === null || !("text" in obj || "tool_calls" in obj)) return undefined;
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

interface RunOutcome {
	finalText: string;
	stopReason?: string;
	error?: string;
}

const AGENT_NAME = "nexo";
const RETRY_NOTE = "\n\nYour previous reply was not a single valid JSON object in the required format. Reply again with only that JSON object.";

function streamKiroP(run: KiroPRunner, model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
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

		let dir: string | undefined;
		try {
			// The agent lives in a throwaway workspace: Kiro finds it under ./.kiro/agents, and no project files are in reach.
			dir = await mkdtemp(join(tmpdir(), "nexo-kiro-p-"));
			await mkdir(join(dir, ".kiro", "agents"), { recursive: true });
			const agent = { name: AGENT_NAME, description: "nexo model turn", prompt: systemPrompt || "You are a helpful assistant.", tools: [], mcpServers: {}, includeMcpJson: false, includePowers: false };
			await writeFile(join(dir, ".kiro", "agents", `${AGENT_NAME}.json`), JSON.stringify(agent), "utf8");
			const args = ["chat", "--v3", "--no-interactive", "--agent", AGENT_NAME, "--trust-tools=", "--output-format", "stream-json", "--model", model.id];
			const effort = effortFlag(options?.reasoning);
			if (effort) args.push("--effort", effort);
			const prompt = renderTranscript(context.messages);
			const cwd = dir;

			stream.push({ type: "start", partial: snapshot() });

			/** One kiro-cli run; plain turns stream their text and thinking into `partial` as it arrives. */
			const runOnce = async (stdin: string): Promise<RunOutcome> => {
				// A missing or rejected agent makes Kiro fall back to its default agent, which has tools: stop the run.
				const kill = new AbortController();
				let fellBack: string | undefined;
				const onAbort = () => kill.abort();
				signal?.addEventListener("abort", onAbort, { once: true });
				const proc = run({
					args,
					stdin,
					cwd,
					signal: kill.signal,
					onStderr: (chunk) => {
						const m = /\[warn\] (agent "[^"]*"[^\n]*)/.exec(chunk);
						if (m && !fellBack) {
							fellBack = m[1];
							kill.abort();
						}
					},
				});
				const outcome: RunOutcome = { finalText: "" };
				let open: { kind: "text" | "thinking"; index: number } | undefined;
				const close = (): void => {
					if (!open) return;
					const block = partial.content[open.index];
					if (block?.type === "text") stream.push({ type: "text_end", contentIndex: open.index, content: block.text, partial: snapshot() });
					else if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: open.index, content: (block as ThinkingContent).thinking, partial: snapshot() });
					open = undefined;
				};
				try {
					for await (const line of proc.lines) {
						if (!line.trim()) continue;
						let event: { type?: string; data?: { status?: string; stopReason?: string; finalText?: string; message?: string; update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } } };
						try {
							event = JSON.parse(line);
						} catch {
							continue;
						}
						const data = event.data ?? {};
						if (event.type === "runFinished") {
							outcome.finalText = data.finalText ?? "";
							outcome.stopReason = data.stopReason;
							if (data.status !== "success") outcome.error = `run ${data.status ?? "failed"}${data.stopReason ? ` (${data.stopReason})` : ""}`;
						} else if (event.type === "runError") outcome.error = data.message ?? "run failed";
						else if (event.type === "sessionUpdate" && !useTools) {
							const kind = data.update?.sessionUpdate === "agent_message_chunk" ? "text" : data.update?.sessionUpdate === "agent_thought_chunk" ? "thinking" : undefined;
							const delta = data.update?.content?.type === "text" ? data.update.content.text : undefined;
							if (!kind || !delta) continue;
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
						}
					}
					close();
					const exit = await proc.exit;
					if (fellBack) outcome.error = `stopped: ${fellBack}`;
					else if (!outcome.error && outcome.stopReason === undefined) outcome.error = exit.stderr.trim().split("\n").at(-1) || `exited with code ${exit.code ?? "null"} without a result`;
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
				return outcome;
			};

			let outcome = await runOnce(prompt);
			if (signal?.aborted) return fail("aborted", "Request was aborted");
			if (outcome.error) return fail("error", `kiro-cli failed: ${outcome.error}`);

			let stopReason: "stop" | "length" | "toolUse" = outcome.stopReason === "max_tokens" ? "length" : "stop";
			if (useTools) {
				let reply = parseReply(outcome.finalText, tools);
				if (!reply) {
					outcome = await runOnce(`${prompt}${RETRY_NOTE}`);
					if (signal?.aborted) return fail("aborted", "Request was aborted");
					if (outcome.error) return fail("error", `kiro-cli failed: ${outcome.error}`);
					reply = parseReply(outcome.finalText, tools);
				}
				// Still not the JSON format: keep what the model said as a plain answer rather than dropping it.
				const { text, calls } = reply ?? { text: outcome.finalText, calls: [] };
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
			} else if (!partial.content.some((b) => b.type === "text") && outcome.finalText) {
				pushText(outcome.finalText);
			}
			const message: AssistantMessage = { ...snapshot(), stopReason };
			stream.push({ type: "done", reason: stopReason, message });
			stream.end(message);
		} catch (error) {
			if (signal?.aborted) return fail("aborted", "Request was aborted");
			fail("error", `kiro-cli failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
	return stream;
}

/**
 * Runs models through the local Kiro CLI's v3 engine (`kiro-cli chat --v3 --no-interactive`), authenticated by the
 * CLI's own login. Each turn gets a throwaway agent carrying the system prompt and no tools, plus `--trust-tools=` so
 * nothing Kiro might still offer can run. Nexo tools are described in the prompt and the reply parsed as
 * `{ text, tool_calls }` (one retry when it does not parse), so tool turns arrive whole rather than streamed. Kiro bills
 * in credits and reports no token counts, so usage is empty.
 */
export function kiroPProvider(options: KiroPProviderOptions = {}): Provider {
	const run = options.run ?? spawnRunner(options.command ?? process.env[KIRO_P_COMMAND_ENV] ?? "kiro-cli");
	const api = {
		stream: (model: Model<string>, context: TranscriptContext, opts?: SimpleStreamOptions) => streamKiroP(run, model, context, opts),
		streamSimple: (model: Model<string>, context: TranscriptContext, opts?: SimpleStreamOptions) => streamKiroP(run, model, context, opts),
	};
	return createProvider({
		id: KIRO_P_PROVIDER,
		name: "Kiro CLI (kiro-cli chat --v3)",
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
