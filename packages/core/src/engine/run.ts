import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, isContextOverflow, isRetryableAssistantError, type Model, type Models } from "@earendil-works/pi-ai";
import { createModelRegistry, type Effort, type ModelChoice, type ModelRegistry, type ResolvedModel, resolveModel } from "@nexo/router";
import { createLoadSkillTool, formatSkillIndex, type SkillCatalog } from "@nexo/skills";
import {
	createArtifactSet,
	type ArtifactSetMember,
	type Db,
	ensureManualArtifact,
	insertRun,
	isPidAlive,
	newId,
	type NexoPaths,
	recoverCrashedRuns,
	RunDir,
	type RunJson,
	type RunStatus,
	type TaskGraphRecord,
	updateRun,
} from "@nexo/store";
import { type ErrorPayload, type Logger, NexoError, type Redactor, toErrorPayload } from "@nexo/telemetry";
import {
	type ChangeTracker,
	createBuiltinTools,
	createChangeTracker,
	createPolicy,
	FileLeases,
	type Prompter,
	TOOL_OUTPUT_PREFIX,
	type ToolPolicy,
} from "@nexo/tools";
import { realpathSync, statSync } from "node:fs";
import type { NexoConfig } from "../config/schema.ts";
import { checkAdmission, recordSpend } from "../cost/admission.ts";
import { budgetLine, RunBudget } from "../cost/budget.ts";
import { estimateCallCostUsd, priceUsage } from "../cost/pricing.ts";
import { classifyProviderError, contextOverflowError, retryAfterMs, toolErrorText, withToolErrorCodes } from "./errors.ts";
import { assistantText, contentText, estimatePromptChars, lastAssistant, recordedContent, withBudgetLine } from "./messages.ts";
import { DEFAULT_PLANNER_PROMPT, DEFAULT_SYSTEM_PROMPT, renderSystemPrompt } from "./prompts.ts";
import { createGatedStreamFn } from "./provider-gate.ts";
import { Recorder } from "./recorder.ts";

const TOOL_RESULT_INLINE_LIMIT = 32_768;
const TOOL_RESULT_EXCERPT_CHARS = 8_000;

/** The head and tail of a large tool result, with a note pointing at the saved full text. */
function toolOutputExcerpt(text: string, pointer: string): string {
	const omitted = text.length - 2 * TOOL_RESULT_EXCERPT_CHARS;
	const note = `[${omitted} characters omitted. The full output is saved; read it with read({ path: "${pointer}", offset, limit }), where offset and limit count lines.]`;
	return `${text.slice(0, TOOL_RESULT_EXCERPT_CHARS)}\n\n${note}\n\n${text.slice(-TOOL_RESULT_EXCERPT_CHARS)}`;
}

export interface EngineDeps {
	config: NexoConfig;
	configHash: string;
	paths: NexoPaths;
	db: Db;
	models: Models;
	logger: Logger;
	redact: Redactor;
	prompter: Prompter;
	skills: SkillCatalog;
	now?: () => Date;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	onEvent?: (event: EngineEvent) => void;
}

export type EngineEvent =
	| { type: "run_start"; runId: string; parentRunId: string | null; instruction: string; depth: number }
	| { type: "text_delta"; runId: string; depth: number; delta: string }
	| { type: "tool_start"; runId: string; depth: number; toolName: string }
	| { type: "run_end"; runId: string; depth: number; status: RunStatus; costUsd: number };

export interface RunRequest {
	instruction: string;
	skill?: string;
	model?: string;
	effort?: Effort;
	workspace?: string;
	budgetUsd?: number;
}

export interface RunResult {
	trajectoryId: string | null;
	runDir: string | null;
	status: RunStatus;
	output: string;
	costUsd: number;
	costUnknown: boolean;
	error?: ErrorPayload;
}

export interface Engine {
	run(request: RunRequest, signal?: AbortSignal): Promise<RunResult>;
}

/** Shared, run-tree-wide services. */
export interface EngineEnv {
	deps: EngineDeps;
	now: () => Date;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	registry: ModelRegistry;
	policy: ToolPolicy;
	streamFn: ReturnType<typeof createGatedStreamFn>;
}

/** Link from a child run to its parent; absent for root runs. */
export interface ParentLink {
	runId: string;
	rootRunId: string;
	runDir: RunDir;
	spanId: string;
	depth: number;
	leases: FileLeases;
	sharedWorkspace: string | null;
	changeTracker: ChangeTracker | null;
	parentRemainingFraction: number;
}

export interface ExecuteInput {
	request: RunRequest;
	budget: RunBudget;
	parent?: ParentLink;
	signal?: AbortSignal;
}

/** Context handed to extra tool factories (the spawn tool) for the run being built. */
export interface RunToolContext {
	env: EngineEnv;
	runId: string;
	rootRunId: string;
	runDir: RunDir;
	depth: number;
	budget: RunBudget;
	leases: FileLeases;
	sharedWorkspace: string | null;
	changeTracker: ChangeTracker | null;
	recorder: Recorder;
	toolSpanId: (toolCallId: string) => string | null;
	recordTaskGraph: (record: TaskGraphRecord) => void;
	addChildCost: (usd: number, unknown: boolean) => void;
}

export type ExtraToolsFactory = (ctx: RunToolContext) => AgentTool<any>[];

const extraToolFactories: ExtraToolsFactory[] = [];

/** Registers tools that every run receives in addition to the built-ins (used by the spawn tool). Returns an unregister function. */
export function registerExtraTools(factory: ExtraToolsFactory): () => void {
	extraToolFactories.push(factory);
	return () => {
		const index = extraToolFactories.indexOf(factory);
		if (index >= 0) extraToolFactories.splice(index, 1);
	};
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(signal.reason);
		}, { once: true });
	});
}

function failedResult(redact: Redactor, error: unknown, status: RunStatus = "failed"): RunResult {
	return { trajectoryId: null, runDir: null, status, output: "", costUsd: 0, costUnknown: false, error: redact(toErrorPayload(error)) };
}

export function createEngine(deps: EngineDeps): Engine {
	const now = deps.now ?? (() => new Date());
	const limits: Record<string, number | undefined> = {};
	for (const [name, p] of Object.entries(deps.config.providers)) limits[name] = p.maxConcurrent;
	const env: EngineEnv = {
		deps,
		now,
		sleep: deps.sleep ?? defaultSleep,
		registry: createModelRegistry(deps.models),
		policy: createPolicy(deps.config.tools),
		streamFn: createGatedStreamFn(deps.models, limits),
	};
	const recovered = recoverCrashedRuns(deps.db, isPidAlive, now().toISOString());
	if (recovered.length > 0) deps.logger.warn("marked crashed runs as aborted", { run_ids: recovered });

	return {
		async run(request, signal) {
			try {
				checkAdmission(deps.db, deps.config.budgets, now());
			} catch (error) {
				return failedResult(deps.redact, error, "budget_exceeded");
			}
			let budget: RunBudget;
			try {
				budget = new RunBudget(request.budgetUsd ?? deps.config.budgets.perRunUsd);
			} catch (error) {
				return failedResult(deps.redact, error);
			}
			return executeRun(env, { request, budget, signal });
		},
	};
}

/** The shared workspace a run edits in place, or null when it uses its own isolated run workspace. */
function resolveSharedWorkspace(request: RunRequest, parent: ParentLink | undefined): string | null {
	if (parent) return parent.sharedWorkspace;
	if (!request.workspace) return null;
	let real: string;
	try {
		real = realpathSync(request.workspace);
	} catch (cause) {
		throw new NexoError({ code: "CONFIG_INVALID", message: `Workspace ${request.workspace} does not exist`, hint: "Pass an existing directory to --workspace", cause });
	}
	if (!statSync(real).isDirectory()) throw new NexoError({ code: "CONFIG_INVALID", message: `Workspace ${request.workspace} is not a directory` });
	return real;
}

export async function executeRun(env: EngineEnv, input: ExecuteInput): Promise<RunResult> {
	const { deps, now } = env;
	const { config, db } = deps;
	const { request, budget, parent } = input;
	const depth = parent ? parent.depth : 0;

	// Resolve skill, model and workspace before creating anything on disk.
	const skill = request.skill ? deps.skills.skills.get(request.skill) : undefined;
	if (request.skill && !skill) {
		return failedResult(deps.redact, new NexoError({
			code: "SKILL_NOT_FOUND",
			message: `Unknown skill "${request.skill}"`,
			hint: `Available: ${[...deps.skills.skills.keys()].join(", ") || "(none)"}`,
		}));
	}
	const pin = request.skill ? config.skills.pins[request.skill] : undefined;
	let resolved: ResolvedModel;
	let model: Model<Api>;
	let sharedWorkspace: string | null;
	let runDir: RunDir;
	const runId = newId();
	try {
		const user: ModelChoice = { model: (parent ? undefined : request.model) ?? pin?.model, effort: (parent ? undefined : request.effort) ?? pin?.effort };
		const parentChoice: ModelChoice | undefined = parent ? { model: request.model, effort: request.effort } : undefined;
		resolved = resolveModel({
			user,
			parent: parentChoice,
			skill: skill ? { model: skill.meta.model, effort: skill.meta.effort, allowed: skill.meta.modelAllowed } : undefined,
			roles: { s1: config.models.s1, s2: config.models.s2 },
			remainingFraction: parent ? parent.parentRemainingFraction : budget.remainingFraction(),
		});
		model = env.registry.get(resolved.provider, resolved.id);
		resolved = { ...resolved, effort: env.registry.clampEffort(model, resolved.effort) };
		sharedWorkspace = resolveSharedWorkspace(request, parent);
		runDir = parent ? parent.runDir.child(runId) : RunDir.create(deps.paths.runs, runId, deps.redact);
	} catch (error) {
		return failedResult(deps.redact, error);
	}

	const rootRunId = parent?.rootRunId ?? runId;
	const startedAt = now().toISOString();
	const leases = parent?.leases ?? new FileLeases();
	if (parent) leases.link(runId, parent.runId);
	const logger = deps.logger.child({ run_id: runId, correlation_id: rootRunId });
	const taskGraphs: TaskGraphRecord[] = [];
	let ownCost = 0;
	let childCost = 0;
	let costUnknown = false;
	let tokensIn = 0;
	let tokensOut = 0;
	const workspace = sharedWorkspace ?? runDir.workspaceDir;
	let changeTracker: ChangeTracker | null = parent?.changeTracker ?? null;
	let artifactSetId: string | null = null;

	const recorder = new Recorder({ db, runDir, runId, now, redact: deps.redact });
	const runJson = (status: RunStatus, output: string, error: ErrorPayload | null): RunJson => ({
		id: runId,
		parentRunId: parent?.runId ?? null,
		rootRunId,
		instruction: request.instruction,
		skill: request.skill ?? null,
		status,
		model: { provider: resolved.provider, id: resolved.id, effort: resolved.effort, source: resolved.source, role: resolved.role },
		startedAt,
		endedAt: status === "running" ? null : now().toISOString(),
		costUsd: ownCost + childCost,
		costUnknown,
		tokensIn,
		tokensOut,
		output,
		error,
		artifactSetId,
		configSnapshotHash: deps.configHash,
		workspace,
		taskGraphs,
	});

	// Setup up to and including the DB row. A failure here leaves no row, only a failed run.json.
	try {
		if (!parent && sharedWorkspace) changeTracker = createChangeTracker(sharedWorkspace, runDir.changesDir, (s) => deps.redact(s));

		// Snapshot the exact artifacts this run uses.
		const nowIso = now().toISOString();
		const members: ArtifactSetMember[] = [];
		const snapshot = (kind: ArtifactSetMember["kind"], name: string, content: string, relPath: string) => {
			const a = ensureManualArtifact(db, kind, name, deps.redact(content), nowIso);
			members.push({ kind, name, artifactId: a.id, version: a.version });
			runDir.writeArtifact(relPath, content);
		};
		snapshot("system_prompt", "default", DEFAULT_SYSTEM_PROMPT, "system_prompt.md");
		snapshot("planner_prompt", "default", DEFAULT_PLANNER_PROMPT, "planner_prompt.md");
		if (skill) snapshot("skill", skill.name, skill.content, `skills/${skill.name}/SKILL.md`);
		artifactSetId = createArtifactSet(db, members, nowIso);
		runDir.writeArtifact("config.json", JSON.stringify(config, null, 2));

		insertRun(db, {
			id: runId,
			parentRunId: parent?.runId ?? null,
			rootRunId,
			dirPath: runDir.root,
			instruction: deps.redact(request.instruction),
			skill: request.skill ?? null,
			status: "running",
			configSnapshotHash: deps.configHash,
			artifactSetId,
			modelFinal: `${resolved.provider}/${resolved.id}`,
			tierFinal: resolved.role,
			escalations: 0,
			startedAt,
			endedAt: null,
			costUsd: 0,
			costUnknown: false,
			tokensIn: 0,
			tokensOut: 0,
			pid: process.pid,
			error: null,
		});
	} catch (caught) {
		logger.error("run setup failed", { error: caught });
		const payload = deps.redact(toErrorPayload(caught));
		try {
			runDir.writeRunJson(runJson("failed", "", payload));
		} catch {}
		return { trajectoryId: runId, runDir: runDir.root, status: "failed", output: "", costUsd: 0, costUnknown: false, error: payload };
	}

	// From here the DB row exists: every path below ends by writing a terminal status to run.json and the DB.
	let status: RunStatus = "succeeded";
	let error: ErrorPayload | null = null;
	let output = "";
	let runSpan: string | null = null;
	let turnSpan: string | null = null;
	let llmSpan: string | null = null;
	let agent: Agent | null = null;
	let budgetExceeded = false;
	const onAbort = () => agent?.abort();
	try {
		runSpan = recorder.start({
			kind: "run",
			name: request.skill ? `skill:${request.skill}` : "run",
			parentSpanId: null,
			attrs: { instruction: deps.redact(request.instruction), parentSpanId: parent?.spanId ?? null, depth },
		});
		const rootSpan = runSpan;
		runDir.writeRunJson(runJson("running", "", null));
		deps.onEvent?.({ type: "run_start", runId, parentRunId: parent?.runId ?? null, instruction: deps.redact(request.instruction), depth });

		// Tools.
		const toolSpans = new Map<string, string>();
		const toolPayloadRefs = new Map<string, string>();
		const baseTools: AgentTool<any>[] = [
			...createBuiltinTools({
				workspaceRoot: workspace,
				holder: runId,
				leases,
				changeTracker: changeTracker ?? undefined,
				bashTimeoutMs: config.tools.bashTimeoutMs,
				toolOutputsDir: runDir.toolOutputsDir,
			}),
			createLoadSkillTool({
				catalog: deps.skills,
				onLoad: (s) => {
					ensureManualArtifact(db, "skill", s.name, deps.redact(s.content), now().toISOString());
					runDir.writeArtifact(`skills/${s.name}/SKILL.md`, s.content);
				},
			}),
		];
		const toolCtx: RunToolContext = {
			env,
			runId,
			rootRunId,
			runDir,
			depth,
			budget,
			leases,
			sharedWorkspace,
			changeTracker,
			recorder,
			toolSpanId: (id) => toolSpans.get(id) ?? null,
			recordTaskGraph: (record) => taskGraphs.push(record),
			addChildCost: (usd, unknown) => {
				childCost += usd;
				costUnknown ||= unknown;
			},
		};
		for (const factory of extraToolFactories) baseTools.push(...factory(toolCtx));
		const tools = baseTools.map(withToolErrorCodes);

		const systemPrompt = renderSystemPrompt({
			systemPrompt: DEFAULT_SYSTEM_PROMPT,
			plannerPrompt: tools.some((t) => t.name === "spawn") ? DEFAULT_PLANNER_PROMPT : null,
			workspace,
			skillIndex: formatSkillIndex(deps.skills),
			activeSkill: skill ? { name: skill.name, body: skill.body } : undefined,
		});

		/** Prompt size for the pre-call estimate: the system prompt, the tool definitions and the non-system transcript. */
		const requestChars = (messages: readonly AgentMessage[], requestTools: readonly AgentTool<any>[]): number =>
			systemPrompt.length +
			JSON.stringify(requestTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length +
			estimatePromptChars(messages.filter((m) => m.role !== "system"));

		const overrides = config.pricingOverrides;
		const runAgent: Agent = new Agent({
			streamFn: env.streamFn,
			initialState: { systemPrompt, model, thinkingLevel: resolved.effort, tools },
			toolExecution: "parallel",
			prepareRequest: async ({ context, model: requestModel }) => {
				const chars = requestChars(context.messages, context.tools ?? tools);
				const estimate = estimateCallCostUsd(requestModel, overrides, chars, config.budgets.estimateOutputTokens);
				if (!budget.canAfford(estimate)) {
					budgetExceeded = true;
					runAgent.abort();
				}
				return undefined;
			},
			transformContext: async (messages) => withBudgetLine(messages, budgetLine(budget)),
			beforeToolCall: async ({ toolCall, args }, signal) => {
				if (budget.isExhausted()) {
					budgetExceeded = true;
					return { block: true, reason: "BUDGET_EXCEEDED: the run budget is exhausted", terminate: true };
				}
				const auth = await env.policy.authorize(deps.prompter, toolCall.name, args, signal, depth > 0 ? `subagent ${runId.slice(-6)}` : undefined);
				if (!auth.allowed) return { block: true, reason: toolErrorText(auth.error) };
				return undefined;
			},
			afterToolCall: async ({ toolCall, result }) => {
				const text = contentText(result.content);
				const spanId = toolSpans.get(toolCall.id);
				if (text.length <= TOOL_RESULT_INLINE_LIMIT || !spanId) return undefined;
				const payloadRef = runDir.writeToolOutput(spanId, text);
				toolPayloadRefs.set(toolCall.id, payloadRef);
				const pointer = `${TOOL_OUTPUT_PREFIX}${payloadRef.slice("tool_outputs/".length)}`;
				const nonText = result.content.filter((block) => block.type !== "text");
				return { content: [{ type: "text", text: toolOutputExcerpt(text, pointer) }, ...nonText] };
			},
		});
		agent = runAgent;

		let turnIndex = 0;
		runAgent.subscribe((event: AgentEvent) => {
			switch (event.type) {
				case "turn_start":
					turnSpan = recorder.start({ kind: "turn", name: `turn ${++turnIndex}`, parentSpanId: rootSpan });
					break;
				case "message_start":
					if (event.message.role === "assistant") {
						if (llmSpan) recorder.finish(llmSpan, { status: "error", attrs: { reason: "superseded by a new assistant message" } });
						llmSpan = recorder.start({
							kind: "llm_call",
							name: model.id,
							parentSpanId: turnSpan ?? rootSpan,
							model: model.id,
							provider: model.provider,
							tier: resolved.role ?? "custom",
							effort: resolved.effort,
							modelSource: resolved.source,
						});
					}
					break;
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta") {
						deps.onEvent?.({ type: "text_delta", runId, depth, delta: event.assistantMessageEvent.delta });
					}
					break;
				case "message_end": {
					if (event.message.role !== "assistant" || !llmSpan) break;
					const msg = event.message as AssistantMessage;
					const priced = priceUsage(model, msg.usage, overrides);
					budget.charge(priced.costUsd);
					recordSpend(db, rootRunId, priced.costUsd, now());
					ownCost += priced.costUsd;
					costUnknown ||= priced.costUnknown;
					tokensIn += msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite;
					tokensOut += msg.usage.output;
					const content = deps.redact(recordedContent(msg));
					const contentJson = JSON.stringify(content);
					const contentRef = contentJson.length > TOOL_RESULT_INLINE_LIMIT ? runDir.writeToolOutput(llmSpan, contentJson) : null;
					recorder.finish(llmSpan, {
						status: msg.stopReason === "error" || msg.stopReason === "aborted" ? "error" : "ok",
						tokensIn: msg.usage.input,
						tokensOut: msg.usage.output,
						cacheRead: msg.usage.cacheRead,
						cacheWrite: msg.usage.cacheWrite,
						costUsd: priced.costUsd,
						costUnknown: priced.costUnknown,
						payloadRef: contentRef,
						attrs: {
							stopReason: msg.stopReason,
							errorMessage: msg.errorMessage,
							responseModel: msg.responseModel,
							content: contentRef ? undefined : content,
						},
					});
					llmSpan = null;
					break;
				}
				case "tool_execution_start": {
					const kind = event.toolName === "load_skill" ? "skill_load" : "tool_call";
					toolSpans.set(event.toolCallId, recorder.start({ kind, name: event.toolName, parentSpanId: turnSpan ?? rootSpan, attrs: { args: deps.redact(event.args) } }));
					deps.onEvent?.({ type: "tool_start", runId, depth, toolName: event.toolName });
					break;
				}
				case "tool_execution_end": {
					const spanId = toolSpans.get(event.toolCallId);
					if (!spanId) break;
					const text = contentText((event.result as { content?: unknown } | undefined)?.content);
					const payloadRef = toolPayloadRefs.get(event.toolCallId) ?? null;
					recorder.finish(spanId, {
						status: event.isError ? "error" : "ok",
						payloadRef,
						attrs: { durationMs: event.durationMs, result: payloadRef ? undefined : deps.redact(text) },
					});
					break;
				}
				case "turn_end":
					if (turnSpan) recorder.finish(turnSpan, { status: "ok" });
					turnSpan = null;
					break;
				default:
					break;
			}
		});

		input.signal?.addEventListener("abort", onAbort, { once: true });
		if (input.signal?.aborted) {
			status = "aborted";
		} else {
			await runAgent.prompt(request.instruction);
			const providerCfg = config.providers[model.provider] ?? {};
			const maxRetries = providerCfg.maxRetries ?? 3;
			const baseDelay = providerCfg.retryBaseDelayMs ?? 1000;
			for (let attempt = 1; ; attempt++) {
				const last = lastAssistant(runAgent.state.messages);
				if (!last || last.stopReason !== "error" || isContextOverflow(last) || !isRetryableAssistantError(last)) break;
				if (attempt > maxRetries || input.signal?.aborted || budgetExceeded) break;
				const delay = Math.max(Math.random() * baseDelay * 2 ** (attempt - 1), retryAfterMs(last.errorMessage ?? "") ?? 0);
				logger.warn("retrying provider error", { attempt, delay_ms: Math.round(delay), error_message: last.errorMessage });
				await env.sleep(delay, input.signal);
				runAgent.state.messages = runAgent.state.messages.slice(0, -1);
				await runAgent.continue();
			}

			const last = lastAssistant(runAgent.state.messages);
			output = assistantText(last);
			if (budgetExceeded) {
				status = "budget_exceeded";
				error = new NexoError({
					code: "BUDGET_EXCEEDED",
					message: `Run budget of $${budget.limitUsd.toFixed(2)} exhausted ($${budget.spentUsd.toFixed(4)} spent)`,
					hint: "Pass --budget or raise budgets.perRunUsd",
				}).toPayload();
			} else if (input.signal?.aborted || last?.stopReason === "aborted") {
				status = "aborted";
			} else if (last?.stopReason === "error") {
				status = "failed";
				const message = last.errorMessage ?? "Provider error";
				error = (isContextOverflow(last) ? contextOverflowError(message) : classifyProviderError(message)).toPayload();
			}
		}
	} catch (caught) {
		if (input.signal?.aborted) {
			// An abort surfaces as a rejection from whatever was awaiting (for example the retry backoff); it is not a failure.
			status = "aborted";
			logger.info("run aborted", { error: caught });
		} else {
			status = "failed";
			error = toErrorPayload(caught);
			logger.error("run failed", { error: caught });
		}
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
		leases.releaseAll(runId);
	}

	const safeError = error ? deps.redact(error) : null;
	const totalCost = ownCost + childCost;
	const attempt = (what: string, fn: () => void) => {
		try {
			fn();
		} catch (caught) {
			logger.error(`${what} failed`, { error: caught });
		}
	};
	if (!parent && changeTracker) {
		const tracker = changeTracker;
		attempt("change tracking", () => tracker.finalize());
	}
	const spanStatus = status === "succeeded" ? "ok" : "error";
	for (const open of [llmSpan, turnSpan]) {
		if (open) attempt("closing open span", () => recorder.finish(open, { status: "error", attrs: { reason: `run ended: ${status}` } }));
	}
	if (runSpan) {
		const span = runSpan;
		attempt("finishing run span", () => recorder.finish(span, { status: spanStatus, costUsd: 0, attrs: { status, totalCostUsd: totalCost } }));
	}
	const finalJson = runJson(status, output, safeError);
	attempt("writing run.json", () => runDir.writeRunJson(finalJson));
	attempt("updating run row", () =>
		updateRun(db, runId, { status, endedAt: finalJson.endedAt, costUsd: totalCost, costUnknown, tokensIn, tokensOut, error: safeError }),
	);
	attempt("run_end event", () => deps.onEvent?.({ type: "run_end", runId, depth, status, costUsd: totalCost }));
	logger.info("run finished", { status, cost_usd: totalCost });
	return { trajectoryId: runId, runDir: runDir.root, status, output, costUsd: totalCost, costUnknown, ...(safeError ? { error: safeError } : {}) };
}
