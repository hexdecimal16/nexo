import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	createProvider,
	getCurrentSystemPrompt,
	getCurrentTools,
	type JsonObject,
	type Message,
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
import { spawnGroup } from "./process-runner.ts";

/** Provider id: models are referenced as `claude-p/<model>`, e.g. `claude-p/opus` or `claude-p/claude-sonnet-5-5`. */
export const CLAUDE_P_PROVIDER = "claude-p";
const CLAUDE_P_API = "claude-p";
/** Environment variable naming the Claude Code executable; `claude` on the PATH otherwise. */
export const CLAUDE_P_COMMAND_ENV = "NEXO_CLAUDE_P_COMMAND";

/** Aliases the Claude Code CLI resolves to the newest model of the family. */
const ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;
/** `claude --effort` values; pi's `minimal` maps to `low`. */
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** One `claude -p` invocation: the arguments after the executable, the prompt on stdin and the working directory. */
export interface ClaudePRequest {
	args: string[];
	stdin: string;
	cwd: string;
	signal?: AbortSignal;
}

/** A running invocation: its stdout lines and its exit. */
export interface ClaudePProcess {
	lines: AsyncIterable<string>;
	exit: Promise<{ code: number | null; stderr: string }>;
}

export type ClaudePRunner = (request: ClaudePRequest) => ClaudePProcess;

export interface ClaudePProviderOptions {
	/** Executable to run; defaults to `$NEXO_CLAUDE_P_COMMAND`, then `claude`. */
	command?: string;
	/** Replaces process spawning (tests). */
	run?: ClaudePRunner;
}

function spawnRunner(command: string): ClaudePRunner {
	return (request) => spawnGroup(command, request);
}

/** The Claude models from pi-ai's Anthropic catalog, re-homed under `claude-p`, plus the CLI's family aliases. */
function claudePModels(): Model<string>[] {
	const anthropic = getBuiltinModels("anthropic").filter((m) => !/-\d{8}$/.test(m.id));
	const rehome = (m: Model<string>, id: string, name: string): Model<string> => ({
		...m,
		id,
		name,
		api: CLAUDE_P_API,
		provider: CLAUDE_P_PROVIDER,
		baseUrl: "",
		input: ["text"],
	});
	const out = anthropic.map((m) => rehome(m, m.id, `${m.name} (claude -p)`));
	for (const alias of ALIASES) {
		const newest = anthropic
			.filter((m) => m.id.startsWith(`claude-${alias}-`))
			.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
			.at(-1);
		if (newest) out.push(rehome(newest, alias, `Claude ${alias} (claude -p, newest)`));
	}
	return out;
}

function contentText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map((b) => (b.type === "text" ? (b.text ?? "") : "[image omitted]")).join("\n");
}

function attr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Renders the conversation for stdin. A lone user message goes as-is; anything longer becomes a tagged transcript. */
export function renderTranscript(messages: readonly Message[]): string {
	const turns = messages.filter((m) => m.role !== "system");
	const only = turns[0];
	if (turns.length === 1 && only?.role === "user") return contentText(only.content);
	const parts: string[] = [];
	for (const m of turns) {
		if (m.role === "user") parts.push(`<user>\n${contentText(m.content)}\n</user>`);
		else if (m.role === "assistant") {
			const body = m.content
				.map((b) => {
					if (b.type === "text") return b.text;
					if (b.type === "toolCall") return `<tool_call id="${attr(b.id)}" name="${attr(b.name)}">${JSON.stringify(b.arguments)}</tool_call>`;
					return "";
				})
				.filter((s) => s.length > 0)
				.join("\n");
			parts.push(`<assistant>\n${body}\n</assistant>`);
		} else if (m.role === "toolResult") {
			parts.push(`<tool_result id="${attr(m.toolCallId)}" name="${attr(m.toolName)}"${m.isError ? ' is_error="true"' : ""}>\n${contentText(m.content)}\n</tool_result>`);
		}
	}
	return `${parts.join("\n\n")}\n\nWrite the assistant's next turn, continuing from the last entry above.`;
}

function plainSchema(tool: Tool): JsonObject {
	return JSON.parse(JSON.stringify(tool.parameters)) as JsonObject;
}

/**
 * System-prompt section describing the tools and the reply format the JSON schema enforces. The definitions are
 * written as data, not tool declarations: Claude otherwise invokes them natively and burns a turn on the failure.
 */
export function toolsSection(tools: readonly Tool[]): string {
	const defs = tools.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: plainSchema(t) })).join("\n");
	return [
		"# Actions",
		"",
		"Your only tool is StructuredOutput, and every reply must be one StructuredOutput call with `text` (what you say to the user, may be empty) and `tool_calls` (actions for the caller to run now, each `{ name, arguments }` with arguments matching the action's parameters).",
		"The actions below are not tools you can invoke: never call them directly, only list them in `tool_calls`. The caller runs them and sends the results back in the next turn as <tool_result> entries. When you are finished, leave `tool_calls` empty and put the final answer in `text`.",
		"",
		"Available actions, one JSON definition per line:",
		defs,
	].join("\n");
}

/** Reply schema for `--json-schema`: each tool call is constrained to one tool's name and parameters. */
export function replySchema(tools: readonly Tool[]): JsonObject {
	return {
		type: "object",
		properties: {
			text: { type: "string" },
			tool_calls: {
				type: "array",
				items: {
					anyOf: tools.map((t) => ({
						type: "object",
						properties: { name: { const: t.name }, arguments: plainSchema(t) },
						required: ["name", "arguments"],
					})),
				},
			},
		},
		required: ["text", "tool_calls"],
	};
}

function effortFlag(reasoning: SimpleStreamOptions["reasoning"]): string | undefined {
	if (!reasoning) return undefined;
	const effort = reasoning === "minimal" ? "low" : reasoning;
	return EFFORTS.has(effort) ? effort : undefined;
}

interface ResultEvent {
	type: "result";
	subtype?: string;
	is_error?: boolean;
	result?: string;
	structured_output?: unknown;
	stop_reason?: string | null;
	api_error_status?: number | null;
	total_cost_usd?: number;
	errors?: unknown;
	usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function toUsage(model: Model<string>, result: ResultEvent | undefined): Usage {
	const u = result?.usage ?? {};
	const usage: Usage = {
		input: u.input_tokens ?? 0,
		output: u.output_tokens ?? 0,
		cacheRead: u.cache_read_input_tokens ?? 0,
		cacheWrite: u.cache_creation_input_tokens ?? 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	usage.cost = calculateCost(model, usage);
	// The CLI's own figure (what the request costs at list price) wins over the catalog estimate.
	if (typeof result?.total_cost_usd === "number" && result.total_cost_usd > 0) usage.cost.total = result.total_cost_usd;
	return usage;
}

function resultError(result: ResultEvent | undefined, exit: { code: number | null; stderr: string }): string | undefined {
	if (result && !result.is_error && result.subtype === "success") return undefined;
	const status = result?.api_error_status ? ` (${result.api_error_status})` : "";
	const detail =
		(result?.result && result.result.trim()) ||
		(Array.isArray(result?.errors) && result.errors.length > 0 ? JSON.stringify(result.errors) : "") ||
		exit.stderr.trim() ||
		(result ? (result.subtype ?? "error") : `exited with code ${exit.code ?? "null"} without a result`);
	return `claude -p failed${status}: ${detail}`;
}

let callSeq = 0;
function toolCallId(): string {
	callSeq = (callSeq + 1) % 1_000_000;
	return `claude_p_${Date.now().toString(36)}_${callSeq}`;
}

function parseStructured(value: unknown): { text: string; calls: ToolCall[] } {
	const obj = (typeof value === "object" && value !== null ? value : {}) as { text?: unknown; tool_calls?: unknown };
	const text = typeof obj.text === "string" ? obj.text : "";
	const calls: ToolCall[] = [];
	if (Array.isArray(obj.tool_calls)) {
		for (const c of obj.tool_calls as { name?: unknown; arguments?: unknown }[]) {
			if (typeof c?.name !== "string") continue;
			const args = typeof c.arguments === "object" && c.arguments !== null && !Array.isArray(c.arguments) ? (c.arguments as JsonObject) : {};
			calls.push({ type: "toolCall", id: toolCallId(), name: c.name, arguments: args });
		}
	}
	return { text, calls };
}

function streamClaudeP(run: ClaudePRunner, model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: toUsage(model, undefined),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	const snapshot = (): AssistantMessage => ({ ...partial, content: [...partial.content] });
	const fail = (reason: "error" | "aborted", message: string, usage?: Usage): void => {
		const error: AssistantMessage = { ...snapshot(), stopReason: reason, errorMessage: message, ...(usage ? { usage } : {}) };
		stream.push({ type: "error", reason, error });
		stream.end(error);
	};

	queueMicrotask(async () => {
		const signal = options?.signal;
		if (signal?.aborted) return fail("aborted", "Request was aborted");
		const tools = getCurrentTools(context.messages);
		const useTools = tools.length > 0 && options?.toolChoice !== "none";
		const systemPrompt = [getCurrentSystemPrompt(context.messages), useTools ? toolsSection(tools) : ""].filter((s) => s.length > 0).join("\n\n");

		let dir: string | undefined;
		try {
			dir = await mkdtemp(join(tmpdir(), "nexo-claude-p-"));
			const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", model.id, "--tools", "", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"];
			if (!useTools) args.push("--include-partial-messages");
			if (systemPrompt) {
				const file = join(dir, "system-prompt.md");
				await writeFile(file, systemPrompt, "utf8");
				args.push("--system-prompt-file", file);
			}
			const effort = effortFlag(options?.reasoning);
			if (effort) args.push("--effort", effort);
			if (useTools) args.push("--json-schema", JSON.stringify(replySchema(tools)));

			const proc = run({ args, stdin: renderTranscript(context.messages), cwd: dir, ...(signal ? { signal } : {}) });
			stream.push({ type: "start", partial: snapshot() });

			let result: ResultEvent | undefined;
			/** Open streamed block per API content index, for the current API message. */
			const open = new Map<number, number>();
			for await (const line of proc.lines) {
				if (!line.trim()) continue;
				let event: { type?: string; parent_tool_use_id?: string | null; event?: Record<string, unknown> } & Partial<ResultEvent>;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (event.type === "result") {
					result = event as ResultEvent;
					continue;
				}
				if (useTools || event.type !== "stream_event" || event.parent_tool_use_id || !event.event) continue;
				const e = event.event as { type: string; index?: number; content_block?: { type: string }; delta?: { type: string; text?: string; thinking?: string } };
				if (e.type === "message_start") open.clear();
				else if (e.type === "content_block_start" && e.index !== undefined) {
					const kind = e.content_block?.type;
					if (kind !== "text" && kind !== "thinking") continue;
					const contentIndex = partial.content.length;
					partial.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
					open.set(e.index, contentIndex);
					stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex, partial: snapshot() });
				} else if (e.type === "content_block_delta" && e.index !== undefined) {
					const contentIndex = open.get(e.index);
					const block = contentIndex === undefined ? undefined : partial.content[contentIndex];
					if (contentIndex === undefined || !block) continue;
					if (block.type === "text" && e.delta?.type === "text_delta" && e.delta.text) {
						block.text += e.delta.text;
						stream.push({ type: "text_delta", contentIndex, delta: e.delta.text, partial: snapshot() });
					} else if (block.type === "thinking" && e.delta?.type === "thinking_delta" && e.delta.thinking) {
						block.thinking += e.delta.thinking;
						stream.push({ type: "thinking_delta", contentIndex, delta: e.delta.thinking, partial: snapshot() });
					}
				} else if (e.type === "content_block_stop" && e.index !== undefined) {
					const contentIndex = open.get(e.index);
					const block = contentIndex === undefined ? undefined : partial.content[contentIndex];
					if (contentIndex === undefined || !block) continue;
					open.delete(e.index);
					if (block.type === "text") stream.push({ type: "text_end", contentIndex, content: block.text, partial: snapshot() });
					else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex, content: (block as ThinkingContent).thinking, partial: snapshot() });
				}
			}
			const exit = await proc.exit;
			if (signal?.aborted) return fail("aborted", "Request was aborted");
			const usage = toUsage(model, result);
			const error = resultError(result, exit);
			if (error) return fail("error", error, usage);

			// Drop thinking the CLI did not display (signature only) so it is not replayed as empty blocks.
			partial.content = partial.content.filter((b) => b.type !== "thinking" || b.thinking.length > 0);
			let stopReason: "stop" | "length" | "toolUse" = result?.stop_reason === "max_tokens" ? "length" : "stop";
			if (useTools) {
				const { text, calls } = parseStructured(result?.structured_output);
				if (text) {
					const contentIndex = partial.content.length;
					partial.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex, partial: snapshot() });
					(partial.content[contentIndex] as TextContent).text = text;
					stream.push({ type: "text_delta", contentIndex, delta: text, partial: snapshot() });
					stream.push({ type: "text_end", contentIndex, content: text, partial: snapshot() });
				}
				for (const call of calls) {
					const contentIndex = partial.content.length;
					partial.content.push({ ...call, arguments: {} });
					stream.push({ type: "toolcall_start", contentIndex, partial: snapshot() });
					partial.content[contentIndex] = call;
					stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: snapshot() });
					stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: snapshot() });
				}
				stopReason = calls.length > 0 ? "toolUse" : "stop";
			} else if (!partial.content.some((b) => b.type === "text") && result?.result) {
				const contentIndex = partial.content.length;
				partial.content.push({ type: "text", text: result.result });
				stream.push({ type: "text_start", contentIndex, partial: snapshot() });
				stream.push({ type: "text_delta", contentIndex, delta: result.result, partial: snapshot() });
				stream.push({ type: "text_end", contentIndex, content: result.result, partial: snapshot() });
			}
			const message: AssistantMessage = { ...snapshot(), usage, stopReason };
			stream.push({ type: "done", reason: stopReason, message });
			stream.end(message);
		} catch (error) {
			if (signal?.aborted) return fail("aborted", "Request was aborted");
			fail("error", `claude -p failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
	return stream;
}

/**
 * Runs Claude through the local Claude Code CLI (`claude -p`), authenticated by whatever login the CLI has (a Claude
 * subscription or its own API key), so no nexo key is needed. Claude's built-in tools are disabled; when the request
 * carries nexo tools, the reply is constrained by `--json-schema` to `{ text, tool_calls }` and returned as real tool
 * calls, so those turns arrive whole rather than streamed.
 */
export function claudePProvider(options: ClaudePProviderOptions = {}): Provider {
	const run = options.run ?? spawnRunner(options.command ?? process.env[CLAUDE_P_COMMAND_ENV] ?? "claude");
	const api = {
		stream: (model: Model<string>, context: TranscriptContext, opts?: SimpleStreamOptions) => streamClaudeP(run, model, context, opts),
		streamSimple: (model: Model<string>, context: TranscriptContext, opts?: SimpleStreamOptions) => streamClaudeP(run, model, context, opts),
	};
	return createProvider({
		id: CLAUDE_P_PROVIDER,
		name: "Claude Code (claude -p)",
		auth: {
			apiKey: {
				name: "Claude Code CLI login",
				resolve: async () => ({ auth: {}, source: "claude CLI login" }),
			},
		},
		models: claudePModels(),
		api,
	});
}
