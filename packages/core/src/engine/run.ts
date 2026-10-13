import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	isContextOverflow,
	isRetryableAssistantError,
	type Message,
	type Model,
	type Models,
	normalizeContext,
} from "@earendil-works/pi-ai";
import {
	createModelRegistry,
	DEFAULT_ROUTER_POLICY,
	type Effort,
	type EscalationBlock,
	type EscalationSignal,
	type EscalationTrigger,
	ESCALATION_BLOCK_REASONS,
	endOfRunSignals,
	escalationBlock,
	isModelAllowed,
	type ModelChoice,
	type ModelRegistry,
	type ResolvedModel,
	resolveModel,
	type RouterPolicy,
	TriggerMonitor,
} from "@nexo/router";
import type { McpHub } from "@nexo/mcp";
import { createLoadSkillTool, formatSkillIndex, type SkillCatalog } from "@nexo/skills";
import {
	createArtifactSet,
	type ArtifactSetMember,
	type Db,
	enqueueLearnJob,
	ensureManualArtifact,
	getActiveArtifact,
	insertRun,
	isPidAlive,
	listPlaybookItems,
	listSpans,
	newId,
	type NexoPaths,
	recoverCrashedRuns,
	RunDir,
	sessionRunDirs,
	type RunJson,
	type RunStatus,
	type ScoreRow,
	type ScorerKind,
	type ScoreStatus,
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
import { join } from "node:path";
import type { NexoConfig } from "../config/schema.ts";
import { checkAdmission, recordSpend } from "../cost/admission.ts";
import { budgetLine, RunBudget } from "../cost/budget.ts";
import { estimateCallCostUsd, priceUsage } from "../cost/pricing.ts";
import { classifyProviderError, contextOverflowError, retryDelayMs, toolErrorText, withToolErrorCodes } from "./errors.ts";
import { assistantText, contentText, estimatePromptChars, lastAssistant, recordedContent, withBudgetLine } from "./messages.ts";
import { DEFAULT_PLANNER_PROMPT, DEFAULT_SYSTEM_PROMPT, renderSystemPrompt } from "./prompts.ts";
import { type ApiKeyResolver, createGatedStreamFn } from "./provider-gate.ts";
import { Recorder } from "./recorder.ts";
import type { ChargedCallDeps } from "../learn/caller.ts";
import { activePlaybook, emptyMemoryContext, playbookSection, retrieveRunMemories, type RunMemoryContext, skillAppendix } from "../learn/context.ts";
import { continuationPrompt } from "../scoring/continuation.ts";
import { planScoring, runScoringRound, runSelfCheck, type ScoringDeps, summarizeSpans } from "../scoring/runner.ts";
import { judgeFamilyWarnings, loadJudgeRubric, loadRouterPolicy } from "../scoring/sources.ts";

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
	/** API key per provider for model requests (settings: environment variable, then credentials file). */
	resolveApiKey?: ApiKeyResolver;
	/** The process's MCP servers; every run gets their tools. The caller closes it. */
	mcp?: McpHub;
}

/** Longest tool result text carried by a `tool_end` preview (`output` carries all of it). */
export const TOOL_END_PREVIEW_CHARS = 2_000;

/**
 * Live progress of a run tree. Payloads are redacted except `text_delta.delta`, which is raw: a secret can be split across
 * deltas, so a consumer redacts the accumulated text. `depth` is 0 for the root run and grows by one per subagent level. */
export type EngineEvent =
	| { type: "run_start"; runId: string; parentRunId: string | null; instruction: string; depth: number }
	| { type: "text_delta"; runId: string; depth: number; delta: string }
	| { type: "tool_start"; runId: string; depth: number; toolName: string; toolCallId: string; args: unknown }
	| { type: "tool_end"; runId: string; depth: number; toolName: string; toolCallId: string; isError: boolean; durationMs: number; preview: string; output: string }
	| { type: "llm_end"; runId: string; depth: number; costUsd: number; costUnknown: boolean; tokensIn: number; tokensOut: number }
	| { type: "compaction_start"; runId: string; depth: number }
	| { type: "compaction_end"; runId: string; depth: number; ok: boolean; costUsd: number }
	| {
			type: "escalation";
			runId: string;
			depth: number;
			trigger: EscalationTrigger;
			reason: string;
			phase: "mid_run" | "end_of_run";
			/** False when the escalation was suppressed; `blockedBy` says why. */
			applied: boolean;
			blockedBy: EscalationBlock | null;
			/** `provider/id` of the model the run continues with. */
			model: string;
	  }
	| {
			/** An applied end-of-run escalation whose S2 continuation failed or ran out of budget; the previous answer is kept. */
			type: "escalation_failed";
			runId: string;
			depth: number;
			trigger: EscalationTrigger;
			error: { code: string; message: string };
	  }
	| {
			type: "score";
			runId: string;
			depth: number;
			round: number;
			scorer: string;
			kind: ScorerKind;
			status: ScoreStatus;
			value: number | null;
			passed: boolean | null;
			costUsd: number;
	  }
	| { type: "run_end"; runId: string; depth: number; status: RunStatus; costUsd: number };

/** What a `prepareHistory` hook can use to shrink the history before the run's first request. */
export interface HistoryContext {
	/** `RunRequest.history`, without system messages. */
	history: Message[];
	/** The model the run will call. */
	model: Model<Api>;
	/** Estimated input tokens of the first request with `messages` as the history: system prompt, tools, messages and the instruction. */
	estimateTokens(messages: readonly Message[]): number;
	/**
	 * One completion by the `s1` model, recorded as a `compaction` span whose cost is charged to this run (its budget,
	 * its cost and the spend ledger). Throws when the budget cannot cover the estimate, on provider errors and on abort.
	 */
	summarize(input: { system: string; text: string }): Promise<string>;
	signal?: AbortSignal;
}

export type HistoryPreparer = (ctx: HistoryContext) => Promise<Message[]>;

export interface RunRequest {
	instruction: string;
	skill?: string;
	model?: string;
	effort?: Effort;
	workspace?: string;
	budgetUsd?: number;
	/** Conversation so far, seeded into the agent before the instruction. System messages are dropped. */
	history?: Message[];
	/** Runs before the first request and returns the history to seed instead of `history`. */
	prepareHistory?: HistoryPreparer;
	/** Session link, recorded on the run and in its run.json; spend is also charged to the `session:<id>` ledger scope. */
	sessionId?: string;
	turnIndex?: number;
}

export interface RunModelInfo {
	provider: string;
	id: string;
	effort: Effort;
	contextWindow: number;
}

export interface RunResult {
	trajectoryId: string | null;
	runDir: string | null;
	status: RunStatus;
	output: string;
	costUsd: number;
	costUnknown: boolean;
	error?: ErrorPayload;
	/** The run's new messages in order: the instruction, assistant messages and tool results. Empty when no run started. */
	messages: Message[];
	/** The model the run ended on (S2 after an escalation); null when it failed before resolving one. */
	model: RunModelInfo | null;
	/** The latest scoring round; absent when nothing scored the run. */
	scores?: ScoreRow[];
	/** Escalations that took effect. */
	escalations?: number;
	/** Why the run's S2 continuation failed or ran out of budget (the previous answer was kept); absent otherwise. */
	continuationError?: ErrorPayload;
}

export interface Engine {
	run(request: RunRequest, signal?: AbortSignal): Promise<RunResult>;
	/** The engine's run-tree-wide services; a `LearnWorker` built on it shares the provider gate and registry. */
	readonly env: EngineEnv;
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
	sessionId: string | null;
}

export interface ExecuteInput {
	request: RunRequest;
	budget: RunBudget;
	parent?: ParentLink;
	signal?: AbortSignal;
	/**
	 * Memories retrieved by an earlier run (a session's first turn). The run injects them as they are: it does no
	 * retrieval, charges no query embedding and leaves `last_used_at` alone, so the system prompt stays the same.
	 */
	memoryContext?: RunMemoryContext;
	/** Called with what retrieval at run start chose (not called when `memoryContext` was given). */
	onMemoryContext?: (context: RunMemoryContext) => void;
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
	sessionId: string | null;
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
	return {
		trajectoryId: null,
		runDir: null,
		status,
		output: "",
		costUsd: 0,
		costUnknown: false,
		error: redact(toErrorPayload(error)),
		messages: [],
		model: null,
	};
}

/** Builds the run-tree-wide services and marks runs of dead processes as aborted. */
export function createEngineEnv(deps: EngineDeps): EngineEnv {
	const now = deps.now ?? (() => new Date());
	const limits: Record<string, number | undefined> = {};
	for (const [name, p] of Object.entries(deps.config.providers)) limits[name] = p.maxConcurrent;
	const env: EngineEnv = {
		deps,
		now,
		sleep: deps.sleep ?? defaultSleep,
		registry: createModelRegistry(deps.models),
		policy: createPolicy(deps.config.tools),
		streamFn: createGatedStreamFn(deps.models, limits, deps.resolveApiKey),
	};
	const recovered = recoverCrashedRuns(deps.db, isPidAlive, now().toISOString());
	if (recovered.length > 0) deps.logger.warn("marked crashed runs as aborted", { run_ids: recovered });
	for (const warning of judgeFamilyWarnings(deps.config)) deps.logger.warn(warning);
	return env;
}

export function createEngine(deps: EngineDeps): Engine {
	const env = createEngineEnv(deps);
	const { now } = env;

	return {
		env,
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
	const sessionId = parent ? parent.sessionId : (request.sessionId ?? null);

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
	let escalationTarget: Model<Api>;
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
		escalationTarget = env.registry.get(config.models.s2.provider, config.models.s2.id);
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
	/** The model requests go to; replaced by S2 when an escalation takes effect. */
	let active = { model, resolved };
	let escalations = 0;
	let continuationFailure: ErrorPayload | null = null;
	/** Every model that generated part of the run (S1, and S2 after an escalation), for the judge's same-family check. */
	const usedModels = new Map<string, { provider: string; id: string }>([[`${model.provider}/${model.id}`, { provider: model.provider, id: model.id }]]);
	/** Every scorer result of the run, and those of its latest round. */
	const scoreRows: ScoreRow[] = [];
	let latestScores: ScoreRow[] = [];
	let policy: RouterPolicy = DEFAULT_ROUTER_POLICY;
	let rubric = "";
	// The scorers are fixed before the run starts, so the agent cannot change them by editing a scorer file.
	const plan = planScoring(env, skill, depth, workspace);
	/** The skill's active playbook when the run starts with `--skill` (spec §6), snapshotted with the run's artifacts. */
	const startPlaybook = skill ? getActiveArtifact(db, "playbook", skill.name) : undefined;
	const startPlaybookSection = skill && startPlaybook?.content.trim() ? playbookSection(skill.name, listPlaybookItems(db, skill.name)) : "";
	/** Memories injected at run start; load_skill adds the skill memories it shows. */
	let memoryContext: RunMemoryContext = emptyMemoryContext();
	/** Charges calls made for memory (the query embedding) to this run; set once the run span exists. */
	let memoryDeps: ChargedCallDeps | null = null;

	const recorder = new Recorder({ db, runDir, runId, now, redact: deps.redact });
	const runJson = (status: RunStatus, output: string, error: ErrorPayload | null): RunJson => ({
		id: runId,
		parentRunId: parent?.runId ?? null,
		rootRunId,
		instruction: request.instruction,
		skill: request.skill ?? null,
		status,
		model: {
			provider: active.resolved.provider,
			id: active.resolved.id,
			effort: active.resolved.effort,
			source: active.resolved.source,
			role: active.resolved.role,
		},
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
		...(parent ? {} : { sessionId, turnIndex: request.turnIndex ?? null }),
		...(scoreRows.length > 0 ? { scores: scoreRows } : {}),
		escalations,
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
		if (skill && startPlaybook?.content.trim()) {
			members.push({ kind: "playbook", name: skill.name, artifactId: startPlaybook.id, version: startPlaybook.version });
			runDir.writeArtifact(`playbooks/${skill.name}.md`, startPlaybook.content);
		}
		const routerPolicy = loadRouterPolicy(db, config, nowIso, deps.redact);
		policy = routerPolicy.policy;
		members.push({ kind: "router_policy", name: routerPolicy.artifact.name, artifactId: routerPolicy.artifact.id, version: routerPolicy.artifact.version });
		runDir.writeArtifact("router_policy.json", routerPolicy.artifact.content);
		if (plan.specs.some((s) => s.kind === "llm_judge")) {
			const judgeRubric = loadJudgeRubric(db, config, nowIso, deps.redact);
			rubric = judgeRubric.rubric;
			members.push({ kind: "judge_rubric", name: judgeRubric.artifact.name, artifactId: judgeRubric.artifact.id, version: judgeRubric.artifact.version });
			runDir.writeArtifact("judge_rubric.md", judgeRubric.artifact.content);
		}
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
			sessionId: parent ? null : sessionId,
			turnIndex: parent ? null : (request.turnIndex ?? null),
		});
	} catch (caught) {
		logger.error("run setup failed", { error: caught });
		const payload = deps.redact(toErrorPayload(caught));
		try {
			runDir.writeRunJson(runJson("failed", "", payload));
		} catch {}
		return {
			trajectoryId: runId,
			runDir: runDir.root,
			status: "failed",
			output: "",
			costUsd: 0,
			costUnknown: false,
			error: payload,
			messages: [],
			model: modelInfo(model, resolved),
		};
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
	let seededCount = 0;
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

		// System 1 -> System 2 escalation (spec §7.2).
		const monitor = new TriggerMonitor(policy);
		const blockedOnce = new Set<string>();
		/** Why an escalation may not happen now, or null when it may. Reserved budget counts as spent. */
		const currentBlock = (): EscalationBlock | null =>
			escalationBlock({
				escalations,
				maxEscalations: config.router.maxEscalations,
				spentFraction: 1 - budget.remainingFraction(),
				cutoff: config.budgets.escalationCutoff,
				skillAllows: skill?.meta.escalate ?? true,
				modelAllowed: isModelAllowed("s2", skill?.meta.modelAllowed ?? ["s1", "s2"], { s1: config.models.s1, s2: config.models.s2 }),
				userPinned: resolved.source === "user",
			});
		/**
		 * Applies or records one escalation and returns its span when it took effect, else null. An applied end-of-run
		 * escalation's span is left open for the caller, which finishes it once the continuation has run.
		 */
		const escalate = (signal: EscalationSignal, phase: "mid_run" | "end_of_run"): string | null => {
			if (phase === "mid_run" && active.resolved.role === "s2") return null;
			const from = `${active.model.provider}/${active.model.id}`;
			const blockedBy = currentBlock();
			if (blockedBy) {
				// A suppressed trigger is recorded once per reason, not on every tool error that re-fires it.
				const key = `${signal.trigger}:${blockedBy}`;
				if (blockedOnce.has(key)) return null;
				blockedOnce.add(key);
			} else {
				const s2 = config.models.s2;
				const userEffort = resolved.effortSource === "user";
				const effort = env.registry.clampEffort(escalationTarget, userEffort ? resolved.effort : (s2.effort ?? resolved.effort));
				active = {
					model: escalationTarget,
					resolved: { provider: escalationTarget.provider, id: escalationTarget.id, role: "s2", effort, source: "router", effortSource: userEffort ? "user" : "router" },
				};
				usedModels.set(`${escalationTarget.provider}/${escalationTarget.id}`, { provider: escalationTarget.provider, id: escalationTarget.id });
				escalations++;
			}
			const to = `${active.model.provider}/${active.model.id}`;
			const span = recorder.start({
				kind: "escalation",
				name: signal.trigger,
				parentSpanId: rootSpan,
				model: active.model.id,
				provider: active.model.provider,
				tier: active.resolved.role ?? "custom",
				effort: active.resolved.effort,
				modelSource: active.resolved.source,
				attrs: {
					trigger: signal.trigger,
					reason: signal.reason,
					phase,
					applied: blockedBy === null,
					blockedBy,
					blockedReason: blockedBy ? ESCALATION_BLOCK_REASONS[blockedBy] : null,
					from,
					to,
				},
			});
			if (blockedBy !== null || phase === "mid_run") recorder.finish(span, { status: "ok" });
			deps.onEvent?.({
				type: "escalation",
				runId,
				depth,
				trigger: signal.trigger,
				reason: deps.redact(signal.reason),
				phase,
				applied: blockedBy === null,
				blockedBy,
				model: to,
			});
			logger.info(blockedBy ? "escalation suppressed" : "escalated to s2", {
				trigger: signal.trigger,
				reason: signal.reason,
				blocked_by: blockedBy,
				...(blockedBy ? { blocked_reason: ESCALATION_BLOCK_REASONS[blockedBy] } : {}),
			});
			return blockedBy === null ? span : null;
		};

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
				nexoHome: deps.paths.home,
				toolOutputsDir: runDir.toolOutputsDir,
				// Large-output pointers in a session's history name files saved by earlier turns' runs.
				earlierToolOutputsDirs: sessionId
					? () => sessionRunDirs(db, sessionId).filter((dir) => dir !== runDir.root).map((dir) => join(dir, "tool_outputs"))
					: undefined,
			}),
			createLoadSkillTool({
				catalog: deps.skills,
				onLoad: (s) => {
					ensureManualArtifact(db, "skill", s.name, deps.redact(s.content), now().toISOString());
					runDir.writeArtifact(`skills/${s.name}/SKILL.md`, s.content);
					const hint = monitor.skillLoaded(s.name, s.meta.model);
					if (hint) escalate(hint, "mid_run");
				},
				appendix: (s) => {
					if (!memoryDeps) return "";
					const playbook = activePlaybook(memoryDeps, s.name);
					if (playbook) runDir.writeArtifact(`playbooks/${s.name}.md`, playbook.content);
					return skillAppendix(memoryDeps, memoryContext, s.name);
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
			sessionId,
		};
		for (const factory of extraToolFactories) baseTools.push(...factory(toolCtx));
		if (deps.mcp) baseTools.push(...(await deps.mcp.tools()));
		const tools = baseTools.map(withToolErrorCodes);

		// Retrieval at run start (spec §8.3); the query embedding is charged to this run like any of its calls.
		memoryDeps = {
			env,
			recorder,
			parentSpanId: rootSpan,
			budget,
			signal: input.signal ?? new AbortController().signal,
			charge: (usd, unknown) => {
				recordSpend(db, rootRunId, usd, now(), sessionId);
				ownCost += usd;
				costUnknown ||= unknown;
			},
		};
		if (input.memoryContext) {
			// load_skill adds to `ids`, so the run works on its own copy.
			memoryContext = { ...input.memoryContext, ids: new Set(input.memoryContext.ids) };
		} else if (!input.signal?.aborted) {
			memoryContext = await retrieveRunMemories(memoryDeps, request.instruction, ["user", "global", ...(skill ? [`skill:${skill.name}`] : [])]);
			input.onMemoryContext?.({ ...memoryContext, ids: new Set(memoryContext.ids) });
		}
		// The run directory keeps the memories the run started with (spec §5.1 `context/`).
		if (memoryContext.block) runDir.writeContext("memories.md", memoryContext.block);

		const systemPrompt = renderSystemPrompt({
			systemPrompt: DEFAULT_SYSTEM_PROMPT,
			plannerPrompt: tools.some((t) => t.name === "spawn") ? DEFAULT_PLANNER_PROMPT : null,
			workspace,
			skillIndex: formatSkillIndex(deps.skills),
			activeSkill: skill
				? { name: skill.name, body: startPlaybookSection ? `${skill.body}\n\n${startPlaybookSection}` : skill.body }
				: undefined,
			memories: memoryContext.block,
		});

		/** Prompt size for the pre-call estimate: the system prompt, the tool definitions and the non-system transcript. */
		const requestChars = (messages: readonly AgentMessage[], requestTools: readonly AgentTool<any>[]): number =>
			systemPrompt.length +
			JSON.stringify(requestTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length +
			estimatePromptChars(messages.filter((m) => m.role !== "system"));

		const overrides = config.pricingOverrides;

		/** Charges one priced call to this run: its budget, its own cost, its token totals and the spend ledger. */
		const chargeCall = (callModel: Model<Api>, msg: AssistantMessage) => {
			const priced = priceUsage(callModel, msg.usage, overrides);
			budget.charge(priced.costUsd);
			recordSpend(db, rootRunId, priced.costUsd, now(), sessionId);
			ownCost += priced.costUsd;
			costUnknown ||= priced.costUnknown;
			tokensIn += msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite;
			tokensOut += msg.usage.output;
			deps.onEvent?.({
				type: "llm_end",
				runId,
				depth,
				costUsd: priced.costUsd,
				costUnknown: priced.costUnknown,
				tokensIn: msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite,
				tokensOut: msg.usage.output,
			});
			return priced;
		};

		const summarize = async (req: { system: string; text: string }): Promise<string> => {
			const role = config.models.s1;
			const summaryModel = env.registry.get(role.provider, role.id);
			const effort = env.registry.clampEffort(summaryModel, role.effort ?? "off");
			const estimate = estimateCallCostUsd(summaryModel, overrides, req.system.length + req.text.length, config.budgets.estimateOutputTokens);
			if (!budget.canAfford(estimate)) {
				throw new NexoError({
					code: "BUDGET_EXCEEDED",
					message: `The run budget cannot cover the compaction call (estimated $${estimate.toFixed(4)}, $${budget.remainingUsd().toFixed(4)} left)`,
					hint: "Raise the run budget (or the session budget) so the compaction call fits",
				});
			}
			const span = recorder.start({
				kind: "compaction",
				name: summaryModel.id,
				parentSpanId: rootSpan,
				model: summaryModel.id,
				provider: summaryModel.provider,
				tier: "s1",
				effort,
				modelSource: "default",
			});
			deps.onEvent?.({ type: "compaction_start", runId, depth });
			let costUsd = 0;
			let ok = false;
			try {
				const context = normalizeContext({ systemPrompt: req.system, messages: [{ role: "user", content: req.text, timestamp: now().getTime() }] });
				const stream = await env.streamFn(summaryModel, context, { reasoning: effort === "off" ? undefined : effort, signal: input.signal });
				const msg = await stream.result();
				const priced = chargeCall(summaryModel, msg);
				costUsd = priced.costUsd;
				const summary = assistantText(msg);
				const failed = msg.stopReason === "error" || msg.stopReason === "aborted";
				recorder.finish(span, {
					status: failed ? "error" : "ok",
					tokensIn: msg.usage.input,
					tokensOut: msg.usage.output,
					cacheRead: msg.usage.cacheRead,
					cacheWrite: msg.usage.cacheWrite,
					costUsd: priced.costUsd,
					costUnknown: priced.costUnknown,
					attrs: { stopReason: msg.stopReason, errorMessage: msg.errorMessage, summary: deps.redact(summary) },
				});
				if (msg.stopReason === "aborted") throw new NexoError({ code: "INTERNAL", message: "The compaction call was aborted" });
				if (failed) throw classifyProviderError(msg.errorMessage ?? "Provider error");
				ok = true;
				return summary;
			} catch (caught) {
				if (recorder.get(span)?.status === "running") recorder.finish(span, { status: "error", attrs: { error: deps.redact(toErrorPayload(caught)) } });
				throw caught;
			} finally {
				deps.onEvent?.({ type: "compaction_end", runId, depth, ok, costUsd });
			}
		};

		let history: Message[] = (request.history ?? []).filter((m) => m.role !== "system");
		if (request.prepareHistory && !input.signal?.aborted) {
			const tokensFor = (messages: readonly Message[]) =>
				Math.ceil(requestChars([...messages, { role: "user", content: request.instruction, timestamp: 0 }], tools) / 4);
			history = (await request.prepareHistory({ history, model, estimateTokens: tokensFor, summarize, signal: input.signal })).filter(
				(m) => m.role !== "system",
			);
		}

		const runAgent: Agent = new Agent({
			streamFn: env.streamFn,
			initialState: { systemPrompt, model, thinkingLevel: resolved.effort, tools, messages: history },
			toolExecution: "parallel",
			prepareRequest: async ({ context, model: requestModel }) => {
				const target = active.model;
				const chars = requestChars(context.messages, context.tools ?? tools);
				const estimate = estimateCallCostUsd(target, overrides, chars, config.budgets.estimateOutputTokens);
				if (!budget.canAfford(estimate)) {
					budgetExceeded = true;
					runAgent.abort();
				}
				if (requestModel.provider === target.provider && requestModel.id === target.id) return undefined;
				return { model: target, thinkingLevel: active.resolved.effort };
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
		seededCount = runAgent.state.messages.length;

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
							name: active.model.id,
							parentSpanId: turnSpan ?? rootSpan,
							model: active.model.id,
							provider: active.model.provider,
							tier: active.resolved.role ?? "custom",
							effort: active.resolved.effort,
							modelSource: active.resolved.source,
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
					const priced = chargeCall(active.model, msg);
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
					deps.onEvent?.({ type: "tool_start", runId, depth, toolName: event.toolName, toolCallId: event.toolCallId, args: deps.redact(event.args) });
					break;
				}
				case "tool_execution_end": {
					const text = contentText((event.result as { content?: unknown } | undefined)?.content);
					const output = deps.redact(text);
					deps.onEvent?.({
						type: "tool_end",
						runId,
						depth,
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						isError: event.isError,
						durationMs: event.durationMs ?? 0,
						preview: output.slice(0, TOOL_END_PREVIEW_CHARS),
						output,
					});
					const spanId = toolSpans.get(event.toolCallId);
					if (spanId) {
						const payloadRef = toolPayloadRefs.get(event.toolCallId) ?? null;
						recorder.finish(spanId, {
							status: event.isError ? "error" : "ok",
							payloadRef,
							attrs: { durationMs: event.durationMs, result: payloadRef ? undefined : output },
						});
					}
					const failures = monitor.toolResult(event.isError);
					if (failures) escalate(failures, "mid_run");
					break;
				}
				case "turn_end": {
					if (turnSpan) recorder.finish(turnSpan, { status: "ok" });
					turnSpan = null;
					const calls = event.message.role === "assistant" ? (event.message as AssistantMessage).content : [];
					const argsOf = (id: string) => {
						const call = calls.find((b) => b.type === "toolCall" && b.id === id);
						return JSON.stringify(call?.type === "toolCall" ? call.arguments : null);
					};
					const stagnation = monitor.turnEnd(event.toolResults.map((r) => `${r.toolName}\u0000${argsOf(r.toolCallId)}\u0000${contentText(r.content)}`));
					if (stagnation) escalate(stagnation, "mid_run");
					break;
				}
				default:
					break;
			}
		});

		/** Sends one prompt (the instruction, or a continuation), retries retryable provider errors, and sets status and output. */
		const drive = async (text: string): Promise<void> => {
			await runAgent.prompt(text);
			const providerCfg = config.providers[active.model.provider] ?? {};
			const maxRetries = providerCfg.maxRetries ?? 3;
			const baseDelay = providerCfg.retryBaseDelayMs ?? 1000;
			for (let attempt = 1; ; attempt++) {
				const last = lastAssistant(runAgent.state.messages);
				if (!last || last.stopReason !== "error" || isContextOverflow(last) || !isRetryableAssistantError(last)) break;
				if (attempt > maxRetries || input.signal?.aborted || budgetExceeded) break;
				const delay = retryDelayMs(attempt, baseDelay, last.errorMessage ?? "");
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
		};

		input.signal?.addEventListener("abort", onAbort, { once: true });
		if (input.signal?.aborted) {
			status = "aborted";
		} else {
			await drive(request.instruction);
			// Scoring (spec §7.1 step 5): each failing round may start one S2 continuation, up to router.maxEscalations.
			const selfCheckOn = policy.triggers.self_check.enabled;
			if (status === "succeeded" && (plan.specs.length > 0 || plan.specError !== null || selfCheckOn)) {
				const scoring: ScoringDeps = {
					env,
					runId,
					depth,
					runDir,
					recorder,
					runSpanId: rootSpan,
					budget,
					charge: chargeCall,
					rubric,
					generators: () => [...usedModels.values()],
					signal: input.signal,
				};
				for (let round = 0; status === "succeeded" && !input.signal?.aborted; round++) {
					const scoreInput = {
						runId,
						instruction: request.instruction,
						finalOutput: output,
						runDir: runDir.root,
						workspace,
						trajectory: summarizeSpans(listSpans(db, runId)),
					};
					// The self-check only feeds escalation, so it is skipped when an escalation could not happen anyway.
					const selfCheck = selfCheckOn && currentBlock() === null ? await runSelfCheck(scoring, active.model, active.resolved.effort, active.resolved.role ?? "custom", scoreInput) : null;
					latestScores = await runScoringRound(scoring, plan, scoreInput, round);
					scoreRows.push(...latestScores);
					const judge = latestScores.find((r) => r.scorerType === "llm_judge" && r.status === "ok");
					const signals = endOfRunSignals(policy, {
						selfCheck,
						failedDeterministic: latestScores.filter((r) => r.scorerKind === "deterministic" && r.status === "ok" && r.passed === false).map((r) => r.scorerName),
						judgeScore: judge?.value ?? null,
					});
					const first = signals[0];
					if (!first || input.signal?.aborted) break;
					const combined: EscalationSignal = { trigger: first.trigger, reason: signals.map((x) => x.reason).join("; ") };
					// A continuation that fails or runs out of budget keeps the answer that was scored, and the model that wrote it;
					// an abort still aborts the run.
					const before: { output: string; status: RunStatus; error: ErrorPayload | null; active: typeof active } = { output, status, error, active };
					const escalationSpan = escalate(combined, "end_of_run");
					if (!escalationSpan) break;
					let continuationError: ErrorPayload | null = null;
					try {
						await drive(continuationPrompt(signals, latestScores));
						// drive() updates status and error; the casts undo the narrowing from the loop condition.
						const ended = status as RunStatus;
						const endedError = error as ErrorPayload | null;
						if ((ended === "failed" || ended === "budget_exceeded") && !input.signal?.aborted) {
							continuationError = deps.redact(endedError ?? { code: "INTERNAL", message: `continuation ended ${ended}`, retryable: false });
							logger.warn("S2 continuation failed; keeping the previous answer", { status: ended, error: continuationError });
							output = before.output;
							status = before.status;
							error = before.error;
							active = before.active;
							budgetExceeded = false;
							continuationFailure = continuationError;
							deps.onEvent?.({
								type: "escalation_failed",
								runId,
								depth,
								trigger: combined.trigger,
								error: { code: continuationError.code, message: continuationError.message },
							});
						}
					} finally {
						recorder.finish(escalationSpan, { status: "ok", attrs: continuationError ? { continuationError: { code: continuationError.code, message: continuationError.message } } : {} });
					}
					if (continuationError) break;
				}
				if (input.signal?.aborted) status = "aborted";
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
		updateRun(db, runId, {
			status,
			endedAt: finalJson.endedAt,
			costUsd: totalCost,
			costUnknown,
			tokensIn,
			tokensOut,
			error: safeError,
			modelFinal: `${active.resolved.provider}/${active.resolved.id}`,
			tierFinal: active.resolved.role,
			escalations,
		}),
	);
	// Online learning (spec §7.1 step 6, §8.1): a root run that was not interrupted gets a reflect job; it runs later, in a worker.
	if (!parent && config.learning.enabled && status !== "aborted") {
		attempt("enqueueing the learn job", () => enqueueLearnJob(db, { runId, trigger: "run_end" }, now().toISOString()));
	}
	attempt("run_end event", () => deps.onEvent?.({ type: "run_end", runId, depth, status, costUsd: totalCost }));
	logger.info("run finished", { status, cost_usd: totalCost });
	const messages = agent ? newMessages(agent.state.messages, seededCount) : [];
	return {
		trajectoryId: runId,
		runDir: runDir.root,
		status,
		output,
		costUsd: totalCost,
		costUnknown,
		...(safeError ? { error: safeError } : {}),
		messages,
		model: modelInfo(active.model, active.resolved),
		...(scoreRows.length > 0 ? { scores: latestScores } : {}),
		escalations,
		...(continuationFailure ? { continuationError: continuationFailure } : {}),
	};
}

function modelInfo(model: Model<Api>, resolved: ResolvedModel): RunModelInfo {
	return { provider: model.provider, id: model.id, effort: resolved.effort, contextWindow: model.contextWindow };
}

/** The pi messages appended after the seeded system prompt and history, without system messages. */
function newMessages(messages: readonly AgentMessage[], seededCount: number): Message[] {
	return messages.slice(seededCount).filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}
