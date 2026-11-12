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
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type Tool,
	type ToolCall,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { renderTranscript } from "./claude-p.ts";
import { type SpawnedProcess, type SpawnRequest, spawnGroup } from "./process-runner.ts";

/** Provider id: models are referenced as `codex-p/<model>`, e.g. `codex-p/gpt-6-astra`. */
export const CODEX_P_PROVIDER = "codex-p";
const CODEX_P_API = "codex-p";
/** Environment variable naming the Codex executable; `codex` on the PATH otherwise. */
export const CODEX_P_COMMAND_ENV = "NEXO_CODEX_P_COMMAND";

/** `model_reasoning_effort` values passed through; pi's `minimal` maps to `low`, which every Codex model accepts. */
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

/** Codex features that add tools or prompt sections. All are off, so the model sees only nexo's instructions and actions. */
const DISABLED_FEATURES = [
	"shell_tool",
	"unified_exec",
	"code_mode",
	"code_mode_host",
	"apps",
	"browser_use",
	"computer_use",
	"in_app_browser",
	"image_generation",
	"view_image",
	"sleep_tool",
	"skill_search",
	"tool_suggest",
	"multi_agent",
	"goals",
	"plugins",
	"hooks",
	"request_permissions_tool",
	"default_mode_request_user_input",
];
/** `-c` overrides that drop Codex's own prompt sections (web search, skills, permissions, environment, apps, modes). */
const PROMPT_SECTIONS_OFF = [
	'web_search="disabled"',
	"skills.include_instructions=false",
	"include_permissions_instructions=false",
	"include_environment_context=false",
	"include_apps_instructions=false",
	"include_collaboration_mode_instructions=false",
];
/** Base instructions when the request has no system prompt; Codex's own would otherwise apply. */
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

/** The JSON `codex debug models` prints: `{ models: [{ slug, base_instructions, tool_mode, ... }] }`. */
export type CodexCatalog = { models: Record<string, unknown>[] } & Record<string, unknown>;

export type CodexPRequest = SpawnRequest;
export type CodexPProcess = SpawnedProcess;
export type CodexPRunner = (request: CodexPRequest) => CodexPProcess;

export interface CodexPProviderOptions {
	/** Executable to run; defaults to `$NEXO_CODEX_P_COMMAND`, then `codex`. */
	command?: string;
	/** Replaces process spawning (tests). */
	run?: CodexPRunner;
	/** Replaces loading the model catalog with `codex debug models` (tests). */
	catalog?: () => Promise<CodexCatalog>;
}

/** The models pi-ai lists for ChatGPT-login Codex, re-homed under `codex-p`. */
function codexPModels(): Model<string>[] {
	// `compat` holds OpenAI Responses quirks that do not apply to the codex-p api.
	return getBuiltinModels("openai-codex").map(({ compat: _compat, ...m }): Model<string> => ({
		...m,
		name: `${m.name} (codex exec)`,
		api: CODEX_P_API,
		provider: CODEX_P_PROVIDER,
		baseUrl: "",
		input: ["text"],
	}));
}

function plainSchema(tool: Tool): JsonObject {
	return JSON.parse(JSON.stringify(tool.parameters)) as JsonObject;
}

/** Developer-instructions section describing the tools and the `{ text, tool_calls }` reply the output schema enforces. */
export function codexToolsSection(tools: readonly Tool[]): string {
	const defs = tools.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: plainSchema(t) })).join("\n");
	return [
		"# Actions",
		"",
		"Every reply must be one JSON object matching the response schema: `text` (what you say to the user, may be empty) and `tool_calls` (actions for the caller to run now, each `{ name, arguments_json }`, where `arguments_json` is a JSON-encoded object matching that action's parameters).",
		"Do not run shell commands or use any tool of your own. The caller runs the actions you list and sends the results back in the next turn as <tool_result> entries. When you are finished, leave `tool_calls` empty and put the final answer in `text`.",
		"Your own working directory is an empty scratch directory unrelated to the caller's. Never resolve paths against it: pass relative paths exactly as given, and use only absolute paths that the conversation itself names.",
		"",
		"Available actions, one JSON definition per line:",
		defs,
	].join("\n");
}

/**
 * Reply schema for `--output-schema`. Codex enforces OpenAI strict structured outputs, which reject optional
 * properties, so arguments travel as a JSON string and are parsed here; pi validates them against the tool.
 */
export function codexReplySchema(tools: readonly Tool[]): JsonObject {
	return {
		type: "object",
		properties: {
			text: { type: "string" },
			tool_calls: {
				type: "array",
				items: {
					type: "object",
					properties: { name: { type: "string", enum: tools.map((t) => t.name) }, arguments_json: { type: "string" } },
					required: ["name", "arguments_json"],
					additionalProperties: false,
				},
			},
		},
		required: ["text", "tool_calls"],
		additionalProperties: false,
	};
}

let callSeq = 0;
function toolCallId(): string {
	callSeq = (callSeq + 1) % 1_000_000;
	return `codex_p_${Date.now().toString(36)}_${callSeq}`;
}

/** Parses the final agent message of a tools turn. Unparseable arguments become `{}` so pi's validation reports them to the model. */
export function parseCodexReply(raw: string): { text: string; calls: ToolCall[] } {
	let obj: { text?: unknown; tool_calls?: unknown };
	try {
		obj = JSON.parse(raw) as typeof obj;
	} catch {
		return { text: raw, calls: [] };
	}
	const text = typeof obj?.text === "string" ? obj.text : "";
	const calls: ToolCall[] = [];
	if (Array.isArray(obj?.tool_calls)) {
		for (const c of obj.tool_calls as { name?: unknown; arguments_json?: unknown; arguments?: unknown }[]) {
			if (typeof c?.name !== "string") continue;
			let args: unknown = c.arguments;
			if (typeof c.arguments_json === "string") {
				try {
					args = JSON.parse(c.arguments_json);
				} catch {
					args = undefined;
				}
			}
			const argObj = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as JsonObject) : {};
			calls.push({ type: "toolCall", id: toolCallId(), name: c.name, arguments: argObj });
		}
	}
	return { text, calls };
}

interface CodexUsage {
	input_tokens?: number;
	cached_input_tokens?: number;
	cache_write_input_tokens?: number;
	output_tokens?: number;
}

/** Codex reports `input_tokens` including the cached part; pi counts them separately. */
function toUsage(model: Model<string>, u: CodexUsage | undefined): Usage {
	const cached = u?.cached_input_tokens ?? 0;
	const usage: Usage = {
		input: Math.max(0, (u?.input_tokens ?? 0) - cached),
		output: u?.output_tokens ?? 0,
		cacheRead: cached,
		cacheWrite: u?.cache_write_input_tokens ?? 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	usage.cost = calculateCost(model, usage);
	return usage;
}

function effortFlag(reasoning: SimpleStreamOptions["reasoning"]): string | undefined {
	if (!reasoning) return undefined;
	const effort = reasoning === "minimal" ? "low" : reasoning;
	return EFFORTS.has(effort) ? effort : undefined;
}

function lastLine(text: string): string {
	return text.trim().split("\n").at(-1)?.trim() ?? "";
}

type CodexEvent = {
	type?: string;
	message?: string;
	error?: { message?: string };
	usage?: CodexUsage;
	item?: { type?: string; text?: string };
};

function isCatalog(value: unknown): value is CodexCatalog {
	return typeof value === "object" && value !== null && Array.isArray((value as { models?: unknown }).models);
}

/** Loads the catalog the installed Codex CLI uses (about 1 s, no model call). */
async function readCatalog(run: CodexPRunner): Promise<CodexCatalog> {
	const proc = run({ args: ["debug", "models"], stdin: "", cwd: tmpdir() });
	const lines: string[] = [];
	for await (const line of proc.lines) lines.push(line);
	const exit = await proc.exit;
	let parsed: unknown;
	try {
		parsed = JSON.parse(lines.join("\n"));
	} catch {
		parsed = undefined;
	}
	if (exit.code !== 0 || !isCatalog(parsed)) throw new Error(`codex debug models failed: ${lastLine(exit.stderr) || `exit code ${exit.code ?? "null"}`}`);
	return parsed;
}

/**
 * Rewrites the model's catalog entry so Codex sends only nexo's instructions and no tools of its own: `base_instructions`
 * replaces Codex's 21k-char prompt, `direct_model_only` and `shell_type: disabled` drop the code-mode `exec` and shell
 * tools, and removing `multi_agent_version` and `apply_patch_tool_type` drops the sub-agent and patch tools. These are
 * undocumented catalog fields of Codex 0.167.2, found with `codex debug prompt-input`; a Codex update may rename them.
 */
export function strippedCatalog(catalog: CodexCatalog, slug: string, instructions: string): CodexCatalog {
	const entry = catalog.models.find((m) => m.slug === slug);
	if (!entry) throw new Error(`model ${slug} is not in the Codex CLI's model catalog (codex debug models)`);
	const { multi_agent_version: _agents, model_messages: _messages, apply_patch_tool_type: _patch, ...rest } = entry;
	const stripped = {
		...rest,
		base_instructions: instructions,
		tool_mode: "direct_model_only",
		shell_type: "disabled",
		experimental_supported_tools: [],
		supports_search_tool: false,
	};
	return { ...catalog, models: catalog.models.map((m) => (m === entry ? stripped : m)) };
}

function streamCodexP(
	run: CodexPRunner,
	getCatalog: () => Promise<CodexCatalog>,
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
	const emitText = (text: string): void => {
		const contentIndex = partial.content.length;
		partial.content.push({ type: "text", text });
		stream.push({ type: "text_start", contentIndex, partial: snapshot() });
		stream.push({ type: "text_delta", contentIndex, delta: text, partial: snapshot() });
		stream.push({ type: "text_end", contentIndex, content: text, partial: snapshot() });
	};
	const emitThinking = (thinking: string): void => {
		const contentIndex = partial.content.length;
		partial.content.push({ type: "thinking", thinking });
		stream.push({ type: "thinking_start", contentIndex, partial: snapshot() });
		stream.push({ type: "thinking_delta", contentIndex, delta: thinking, partial: snapshot() });
		stream.push({ type: "thinking_end", contentIndex, content: thinking, partial: snapshot() });
	};
	const emitCall = (call: ToolCall): void => {
		const contentIndex = partial.content.length;
		partial.content.push({ ...call, arguments: {} });
		stream.push({ type: "toolcall_start", contentIndex, partial: snapshot() });
		partial.content[contentIndex] = call;
		stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: snapshot() });
		stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: snapshot() });
	};

	queueMicrotask(async () => {
		const signal = options?.signal;
		if (signal?.aborted) return fail("aborted", "Request was aborted");
		const tools = getCurrentTools(context.messages);
		const useTools = tools.length > 0 && options?.toolChoice !== "none";
		const instructions = [getCurrentSystemPrompt(context.messages), useTools ? codexToolsSection(tools) : ""].filter((s) => s.length > 0).join("\n\n");

		let dir: string | undefined;
		try {
			dir = await mkdtemp(join(tmpdir(), "nexo-codex-p-"));
			const catalogFile = join(dir, "model-catalog.json");
			await writeFile(catalogFile, JSON.stringify(strippedCatalog(await getCatalog(), model.id, instructions || DEFAULT_INSTRUCTIONS)), "utf8");
			// Codex's tools and prompt sections are stripped; the empty temp dir under a read-only sandbox, with no user config
			// or exec rules, stays as a second layer.
			const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-s", "read-only", "-C", dir, "-m", model.id];
			const effort = effortFlag(options?.reasoning);
			if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
			// A JSON string literal is also a valid TOML basic string, which is how `-c` parses the value.
			args.push("-c", `model_catalog_json=${JSON.stringify(catalogFile)}`);
			for (const override of PROMPT_SECTIONS_OFF) args.push("-c", override);
			for (const feature of DISABLED_FEATURES) args.push("--disable", feature);
			if (useTools) {
				const file = join(dir, "reply-schema.json");
				await writeFile(file, JSON.stringify(codexReplySchema(tools)), "utf8");
				args.push("--output-schema", file);
			}
			args.push("-");

			const proc = run({ args, stdin: renderTranscript(context.messages), cwd: dir, ...(signal ? { signal } : {}) });
			stream.push({ type: "start", partial: snapshot() });

			let rawUsage: CodexUsage | undefined;
			let completed = false;
			let turnFailed: string | undefined;
			let lastError: string | undefined;
			let finalMessage: string | undefined;
			for await (const line of proc.lines) {
				if (!line.trim()) continue;
				let event: CodexEvent;
				try {
					event = JSON.parse(line) as CodexEvent;
				} catch {
					continue;
				}
				if (event.type === "item.completed" && event.item) {
					const { type, text } = event.item;
					if (type === "reasoning" && text) emitThinking(text);
					else if (type === "agent_message" && typeof text === "string") {
						if (useTools) finalMessage = text;
						else if (text) emitText(text);
					}
				} else if (event.type === "turn.completed") {
					completed = true;
					rawUsage = event.usage;
				} else if (event.type === "turn.failed") turnFailed = event.error?.message ?? "turn failed";
				else if (event.type === "error" && event.message) lastError = event.message;
			}
			const exit = await proc.exit;
			if (signal?.aborted) return fail("aborted", "Request was aborted");
			const usage = toUsage(model, rawUsage);
			if (turnFailed || !completed) {
				const detail = turnFailed ?? lastError ?? (lastLine(exit.stderr) || `exited with code ${exit.code ?? "null"} without completing a turn`);
				return fail("error", `codex exec failed: ${detail}`, usage);
			}

			let stopReason: "stop" | "toolUse" = "stop";
			if (useTools && finalMessage !== undefined) {
				const { text, calls } = parseCodexReply(finalMessage);
				if (text) emitText(text);
				for (const call of calls) emitCall(call);
				if (calls.length > 0) stopReason = "toolUse";
			}
			const message: AssistantMessage = { ...snapshot(), usage, stopReason };
			stream.push({ type: "done", reason: stopReason, message });
			stream.end(message);
		} catch (error) {
			if (signal?.aborted) return fail("aborted", "Request was aborted");
			fail("error", `codex exec failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
	return stream;
}

/**
 * Runs OpenAI models through the local Codex CLI (`codex exec`), authenticated by whatever login the CLI has (a ChatGPT
 * plan or its own API key), so no nexo key is needed. Codex's own prompt and tools are stripped through a patched model
 * catalog (see `strippedCatalog`), so the system prompt reaches the model as its base instructions. When the request carries nexo tools, the reply is constrained by
 * `--output-schema` to `{ text, tool_calls }` and returned as real tool calls; turns arrive whole, since `codex exec`
 * emits each message only when it completes.
 */
export function codexPProvider(options: CodexPProviderOptions = {}): Provider {
	const command = options.command ?? process.env[CODEX_P_COMMAND_ENV] ?? "codex";
	const run: CodexPRunner = options.run ?? ((request) => spawnGroup(command, request));
	const load = options.catalog ?? (() => readCatalog(run));
	// Loaded once per provider; a failed load is retried on the next call.
	let cached: Promise<CodexCatalog> | undefined;
	const getCatalog = (): Promise<CodexCatalog> => {
		cached ??= load().catch((error: unknown) => {
			cached = undefined;
			throw error;
		});
		return cached;
	};
	const api = {
		stream: (model: Model<string>, context: TranscriptContext, opts?: SimpleStreamOptions) => streamCodexP(run, getCatalog, model, context, opts),
		streamSimple: (model: Model<string>, context: TranscriptContext, opts?: SimpleStreamOptions) => streamCodexP(run, getCatalog, model, context, opts),
	};
	return createProvider({
		id: CODEX_P_PROVIDER,
		name: "Codex CLI (codex exec)",
		auth: {
			apiKey: {
				name: "Codex CLI login",
				resolve: async () => ({ auth: {}, source: "codex CLI login" }),
			},
		},
		models: codexPModels(),
		api,
	});
}
