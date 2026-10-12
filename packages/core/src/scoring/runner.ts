import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Effort } from "@nexo/router";
import {
	type CommandRunner,
	commandScorer,
	containsScorer,
	DATA_BLOCK_NOTE,
	dataBlock,
	humanScorer,
	type JudgeCaller,
	judgeScorer,
	jsonSchemaScorer,
	loadScorerFile,
	type ModelRef,
	regexScorer,
	type Scorer,
	type ScoreInput,
	type ScorerSpec,
	scorerName,
	type SpanSummary,
} from "@nexo/scorers";
import type { Skill } from "@nexo/skills";
import { insertScore, latestFeedback, newId, type RunDir, type ScoreRow, type SpanRow } from "@nexo/store";
import { type ErrorPayload, NexoError, toErrorPayload } from "@nexo/telemetry";
import { createPolicy, runBash } from "@nexo/tools";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { RunBudget } from "../cost/budget.ts";
import type { PricedUsage } from "../cost/pricing.ts";
import { runChargedCompletion } from "../engine/charged-completion.ts";
import type { Recorder } from "../engine/recorder.ts";
import type { EngineEnv, EngineEvent } from "../engine/run.ts";
import { judgeModels } from "./sources.ts";

/** Longest tool-argument text kept per step of the trajectory summary. */
const STEP_DETAIL_CHARS = 200;

/** What a run scores with, and where that list came from. */
export interface ScoringPlan {
	specs: ScorerSpec[];
	/** `skill:<name>`, `config` or `default-judge`; null when nothing scores the run. */
	source: string | null;
	/** Set when the skill's `nexo-scorers` file could not be loaded; recorded as a failed score. */
	specError: ErrorPayload | null;
	/**
	 * "user" for specs from `~/.nexo` (the home config, CLI overrides, skills under NEXO_HOME); "project" for specs from
	 * `./.nexo/config.json`, a skill outside NEXO_HOME or a skill inside the run's workspace. Project-level command scorers
	 * pass the user-level bash tool policy first.
	 */
	origin: "user" | "project";
}

/** True when `dir` is `root` or inside it, comparing real paths. */
function isInside(dir: string, root: string): boolean {
	try {
		const d = realpathSync(dir);
		const r = realpathSync(root);
		return d === r || d.startsWith(r + sep);
	} catch {
		return false;
	}
}

/**
 * The scorers of a run, in priority order: the skill's `nexo-scorers` file, then `scoring.scorers`, then the judge alone
 * when `models.judge` is set. Subagent runs are scored only with `scoring.subagents` or their own skill file. Human
 * specs are left out: human verdicts arrive after the run, through the feedback table. Called before the agent loop
 * starts, so the agent cannot change the run's scorers by editing a scorer file.
 */
export function planScoring(env: EngineEnv, skill: Skill | undefined, depth: number, workspace: string): ScoringPlan {
	const { config, paths } = env.deps;
	const none: ScoringPlan = { specs: [], source: null, specError: null, origin: "user" };
	if (!config.scoring.enabled) return none;
	const runnable = (specs: ScorerSpec[]) => specs.filter((s) => s.kind !== "human");
	if (skill?.meta.scorers) {
		// A skill inside the run's workspace is project-level even under NEXO_HOME (a session started in the home directory).
		const origin = isInside(skill.dir, paths.home) && !isInside(skill.dir, workspace) ? "user" : "project";
		try {
			return { specs: runnable(loadScorerFile(join(skill.dir, skill.meta.scorers))), source: `skill:${skill.name}`, specError: null, origin };
		} catch (error) {
			return { specs: [], source: `skill:${skill.name}`, specError: toErrorPayload(error), origin };
		}
	}
	if (depth > 0 && !config.scoring.subagents) return none;
	if (config.scoring.scorers.length > 0) {
		return { specs: runnable(config.scoring.scorers), source: "config", specError: null, origin: config.scoring.scorersOrigin ?? "project" };
	}
	if (judgeModels(config).length > 0) return { specs: [{ kind: "llm_judge" }], source: "default-judge", specError: null, origin: "user" };
	return none;
}

/** Environment variables that hold provider credentials (API keys, tokens, credential files, cloud access keys). */
const PROVIDER_KEY_VAR =
	/(^|_)(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN(_[A-Z0-9_]+)?|CREDENTIALS|TOKEN_FILE)$|^AWS_CONTAINER_|^(HF_TOKEN|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)$/;

/** The environment command scorers run with: the process environment without provider credential variables. */
export function scorerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) if (!PROVIDER_KEY_VAR.test(key.toUpperCase())) out[key] = value;
	return out;
}

/** The trajectory summary scorers see: tool, skill and subagent steps with redacted arguments, errors and files. */
export function summarizeSpans(spans: readonly SpanRow[]): SpanSummary[] {
	return spans
		.filter((s) => s.kind === "tool_call" || s.kind === "skill_load" || s.kind === "subagent" || s.kind === "escalation")
		.map((s) => {
			const args = (s.attrs.args ?? {}) as Record<string, unknown>;
			const detail = s.kind === "escalation" ? String(s.attrs.reason ?? "") : JSON.stringify(args);
			const result = typeof s.attrs.result === "string" ? s.attrs.result : "";
			const file = (s.name === "write" || s.name === "edit") && s.status === "ok" && typeof args.path === "string" ? args.path : undefined;
			const status = s.status === "running" ? "running" : s.status;
			return {
				kind: s.kind,
				name: s.name,
				status,
				detail: detail.length > STEP_DETAIL_CHARS ? `${detail.slice(0, STEP_DETAIL_CHARS)}…` : detail,
				...(status === "error" && result ? { error: result.slice(0, STEP_DETAIL_CHARS) } : {}),
				...(file ? { file } : {}),
			};
		});
}

export interface ScoringDeps {
	env: EngineEnv;
	runId: string;
	depth: number;
	runDir: RunDir;
	recorder: Recorder;
	/** The run span; scorer spans hang under it. */
	runSpanId: string;
	budget: RunBudget;
	/** Charges one priced call to the run (its budget, cost, tokens and the spend ledger) and emits `llm_end`. */
	charge: (model: Model<Api>, msg: AssistantMessage) => PricedUsage;
	/** The generic judge rubric (active `judge_rubric` artifact). */
	rubric: string;
	/** Models that produced the run, for the judge's same-family check. */
	generators: () => ModelRef[];
	signal?: AbortSignal;
}
/**
 * One LLM completion charged to the run and recorded as a span (`judge_call` for judges, `self_check` for self-checks):
 * `runChargedCompletion` on the run budget, charged through `deps.charge` (the run's cost, tokens and the spend ledger).
 * Parallel calls (panel members, both pairwise orders) reserve their estimates from the same budget, so together they
 * never spend more than it. Throws BUDGET_EXCEEDED when the estimate cannot be reserved, a classified provider error, or
 * on abort.
 */
async function chargedCompletion(
	deps: ScoringDeps,
	model: Model<Api>,
	request: { system: string; user: string; effort: Effort },
	span: { kind: "judge_call" | "self_check"; name: string; parentSpanId: string; tier: string; attrs: Record<string, unknown> },
	signal: AbortSignal,
): Promise<{ text: string; costUsd: number; costUnknown: boolean }> {
	const { budget } = deps;
	return runChargedCompletion(
		{
			env: deps.env,
			recorder: deps.recorder,
			budget,
			charge: deps.charge,
			refused: (estimate) =>
				new NexoError({
					code: "BUDGET_EXCEEDED",
					message: `The run budget cannot cover the ${span.kind === "judge_call" ? "judge" : "self-check"} call (estimated $${estimate.toFixed(4)}, $${budget.remainingUsd().toFixed(4)} left)`,
					hint: "Raise --budget or budgets.perRunUsd so scoring fits after the run",
				}),
			abortMessage: "The scoring call was aborted",
		},
		{ model, system: request.system, user: request.user, effort: request.effort, span },
		signal,
	);
}

/** A JudgeCaller whose calls are `judge_call` spans (tier `judge`) under `scorerSpanId`, charged to the run. */
export function createJudgeCaller(deps: ScoringDeps, scorerSpanId: () => string): JudgeCaller {
	return {
		complete: async (ref, request, signal) => {
			const model = deps.env.registry.get(ref.provider, ref.id);
			return chargedCompletion(
				deps,
				model,
				{ system: request.system, user: request.user, effort: "off" },
				{ kind: "judge_call", name: `${request.purpose} ${model.id}`, parentSpanId: scorerSpanId(), tier: "judge", attrs: { purpose: request.purpose } },
				signal,
			);
		},
	};
}

/**
 * How command scorers run: the bash tool's `runBash` (process group killed on timeout, abort and exit) without provider
 * credentials in the environment. A project-level command first passes the user-level bash tool policy (tools.policy,
 * tools.rules and tools.nonInteractiveAsk from the defaults, ~/.nexo/config.json and CLI flags; ./.nexo/config.json does
 * not count): allow, deny, or ask, where ask uses the interactive prompt and otherwise follows tools.nonInteractiveAsk.
 */
function commandRunner(deps: ScoringDeps, name: string, origin: "user" | "project"): CommandRunner {
	const { env } = deps;
	return async (run) => {
		if (origin === "project") {
			// Only the user-level policy (defaults, ~/.nexo/config.json, CLI flags) applies, so a project cannot approve its own commands.
			const policy = createPolicy(env.deps.config.scoring.scorerTools ?? DEFAULT_CONFIG.tools);
			const auth = await policy.authorize(env.deps.prompter, "bash", { command: run.command }, run.signal, `scorer ${name}`);
			if (!auth.allowed) {
				throw new NexoError({
					code: "SCORER_FAILED",
					message: `Command scorer ${name} was not run: ${auth.error.message}`,
					hint: "Allow the command in tools.policy or tools.rules of ~/.nexo/config.json (project config cannot approve it), or define the scorer in ~/.nexo",
					context: { cause: auth.error.toPayload(), origin },
				});
			}
		}
		return runBash({ ...run, env: scorerEnv(process.env) });
	};
}

function buildScorer(deps: ScoringDeps, spec: ScorerSpec, caller: JudgeCaller, origin: "user" | "project"): Scorer {
	const { config } = deps.env.deps;
	const name = scorerName(spec);
	switch (spec.kind) {
		case "command":
			return commandScorer({ name, command: spec.command, timeoutMs: spec.timeoutMs ?? config.scoring.commandTimeoutMs, run: commandRunner(deps, name, origin) });
		case "json_schema":
			return jsonSchemaScorer({ name, schema: spec.schema });
		case "regex":
			return regexScorer({ name, pattern: spec.pattern, flags: spec.flags, negate: spec.negate });
		case "contains":
			return containsScorer({ name, text: spec.text, ignoreCase: spec.ignoreCase, negate: spec.negate });
		case "llm_judge":
			return judgeScorer({
				name,
				caller,
				models: judgeModels(config),
				rubric: deps.rubric,
				extraRubric: spec.rubric,
				passThreshold: config.scoring.passThreshold,
				generators: deps.generators(),
			});
		case "human":
			return humanScorer({ name, readVerdict: (runId) => latestFeedback(deps.env.deps.db, runId) });
	}
}

function emitScore(deps: ScoringDeps, row: ScoreRow): void {
	const event: EngineEvent = {
		type: "score",
		runId: deps.runId,
		depth: deps.depth,
		round: row.round,
		scorer: row.scorerName,
		kind: row.scorerKind,
		status: row.status,
		value: row.value,
		passed: row.passed,
		costUsd: row.costUsd,
	};
	deps.env.deps.onEvent?.(event);
}

/**
 * Runs every scorer of the plan once (one round), sequentially, and records each result: a `scorer` span, a scores row,
 * files under `scores/round-<n>/` and a `score` event. A scorer that throws is recorded as failed with its error (spec
 * §12: scorer failures never change the run's status). Returns the round's rows.
 */
export async function runScoringRound(deps: ScoringDeps, plan: ScoringPlan, input: ScoreInput, round: number): Promise<ScoreRow[]> {
	const { env, recorder, runDir } = deps;
	const { db, redact } = env.deps;
	const rows: ScoreRow[] = [];
	const record = (row: ScoreRow) => {
		const safe = redact(row);
		insertScore(db, safe);
		rows.push(safe);
		emitScore(deps, safe);
	};
	/** Recording a failure must not fail the run (spec §12): a write error is logged and scoring continues. */
	const guarded = (what: string, fn: () => void) => {
		try {
			fn();
		} catch (error) {
			env.deps.logger.error(`${what} failed`, { error, run_id: deps.runId });
		}
	};
	if (plan.specError) {
		guarded("recording a failed score", () => record({
			id: newId(),
			runId: deps.runId,
			round,
			scorerKind: "deterministic",
			scorerType: "spec",
			scorerName: "nexo-scorers",
			status: "failed",
			value: null,
			passed: null,
			rationale: "",
			criteria: null,
			details: { source: plan.source },
			error: plan.specError,
			model: null,
			costUsd: 0,
			costUnknown: false,
			createdAt: env.now().toISOString(),
		}));
	}
	const signal = deps.signal ?? new AbortController().signal;
	for (const spec of plan.specs) {
		if (signal.aborted) break;
		const name = scorerName(spec);
		const spanId = recorder.start({ kind: "scorer", name, parentSpanId: deps.runSpanId, attrs: { type: spec.kind, round } });
		const caller = createJudgeCaller(deps, () => spanId);
		const base = { id: newId(), runId: deps.runId, round, scorerName: name, scorerType: spec.kind, createdAt: "" };
		let scorer: Scorer;
		try {
			scorer = buildScorer(deps, spec, caller, plan.origin);
			const result = await scorer.score(input, signal);
			const files = Object.entries(result.files ?? {}).map(([file, content]) => runDir.writeScoreFile(`round-${round}/${file}`, content));
			const row: ScoreRow = {
				...base,
				scorerKind: scorer.kind,
				status: "ok",
				value: Math.min(1, Math.max(0, result.value)),
				passed: result.passed,
				rationale: result.rationale,
				criteria: result.criteria ?? null,
				details: { ...(result.details ?? {}), ...(files.length ? { files } : {}) },
				error: null,
				model: result.model ?? null,
				costUsd: result.costUsd,
				costUnknown: result.costUnknown ?? false,
				createdAt: env.now().toISOString(),
			};
			record(row);
			recorder.finish(spanId, { status: "ok", attrs: { value: row.value, passed: row.passed, costUsd: row.costUsd } });
		} catch (caught) {
			if (signal.aborted) {
				// An abort ends the run as aborted: the interrupted scorer gives no verdict and leaves no score row.
				recorder.finish(spanId, { status: "error", attrs: { reason: "aborted" } });
				break;
			}
			const error = caught instanceof NexoError && caught.code === "SCORER_FAILED" ? caught : new NexoError({
				code: "SCORER_FAILED",
				message: `Scorer ${name} failed: ${caught instanceof Error ? caught.message : String(caught)}`,
				cause: caught,
				context: caught instanceof NexoError ? { cause: caught.toPayload() } : {},
			});
			const ctx = error.context ?? {};
			const ctxFiles = (ctx.files ?? {}) as Record<string, string>;
			const files: string[] = [];
			for (const [file, content] of Object.entries(ctxFiles)) {
				guarded("writing a score file", () => files.push(runDir.writeScoreFile(`round-${round}/${file}`, content)));
			}
			const { files: _f, replies: _r, votes, ...rest } = ctx;
			const payload = { ...error.toPayload(), context: rest };
			guarded("recording a failed score", () => record({
				...base,
				scorerKind: spec.kind === "llm_judge" ? "judge" : spec.kind === "human" ? "human" : "deterministic",
				status: "failed",
				value: null,
				passed: null,
				rationale: "",
				criteria: null,
				details: { ...(votes ? { votes } : {}), ...(files.length ? { files } : {}) },
				error: payload,
				model: typeof ctx.model === "string" ? ctx.model : null,
				costUsd: typeof ctx.costUsd === "number" ? ctx.costUsd : 0,
				costUnknown: ctx.costUnknown === true,
				createdAt: env.now().toISOString(),
			}));
			guarded("finishing a scorer span", () => recorder.finish(spanId, { status: "error", attrs: { error: redact(payload) } }));
		}
	}
	return rows;
}

const SELF_CHECK_SYSTEM = `You review your own answer before it is returned. Rate how completely and correctly the answer carries out the instruction.
${DATA_BLOCK_NOTE}
Reply with only a JSON object: {"score": <number from 0 to 1>, "reason": "<one sentence>"}`;

/**
 * Asks the run's current model to rate its final answer (the `self_check` trigger). Returns the score, or null when the
 * call fails or the reply has no score in 0..1; a failed self-check never escalates.
 */
export async function runSelfCheck(deps: ScoringDeps, model: Model<Api>, effort: Effort, role: string, input: ScoreInput): Promise<number | null> {
	const signal = deps.signal ?? new AbortController().signal;
	try {
		const { text } = await chargedCompletion(
			deps,
			model,
			{
				system: SELF_CHECK_SYSTEM,
				user: `# Instruction\n${dataBlock("instruction", input.instruction)}\n\n# Your final answer\n${dataBlock("final_answer", input.finalOutput.slice(-20_000) || "(empty)")}`,
				effort,
			},
			{ kind: "self_check", name: model.id, parentSpanId: deps.runSpanId, tier: role, attrs: {} },
			signal,
		);
		const match = /"score"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(text);
		const score = match ? Number(match[1]) : Number.NaN;
		return Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
	} catch (error) {
		if (signal.aborted) throw error;
		deps.env.deps.logger.warn("self-check failed", { run_id: deps.runId, error });
		return null;
	}
}
