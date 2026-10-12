import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	BudgetStop,
	buildReport,
	type CandidateRef,
	contentOf,
	type EvalCase,
	type GepaEvent,
	MAX_CANDIDATE_CHARS,
	meanOf,
	MINIBATCH_SIZE,
	mulberry32,
	type OptimReport,
	runGepa,
	targetComponents,
	textsOf,
} from "@nexo/optimize";
import {
	type ArtifactRow,
	type CaseScore,
	dayScope,
	type EvalCaseRow,
	getArtifact,
	getOptimRun,
	getRun,
	getSpent,
	insertCandidateArtifact,
	insertOptimCandidate,
	insertOptimRun,
	isPidAlive,
	listEvalCases,
	listOptimCandidates,
	liveJudgeKappa,
	monthScope,
	newId,
	type OptimRunRow,
	type OptimStopReason,
	type OptimTarget,
	parseOptimTarget,
	recoverCrashedOptimRuns,
	resolveSourcedArtifact,
	retireOptimCandidates,
	runsNeedingReview,
	syncRunEvalCases,
	updateOptimCandidate,
	updateOptimRun,
} from "@nexo/store";
import { NexoError, toErrorPayload } from "@nexo/telemetry";
import { nonInteractivePrompter } from "@nexo/tools";
import { checkAdmission } from "../cost/admission.ts";
import { RunBudget } from "../cost/budget.ts";
import { DEFAULT_PLANNER_PROMPT, DEFAULT_SYSTEM_PROMPT } from "../engine/prompts.ts";
import { createEngineEnv, type EngineEnv } from "../engine/run.ts";
import { judgeKey, judgeModels, loadJudgeRubric } from "../scoring/sources.ts";
import { assertReflectionFits } from "./reflect.ts";
import { createOptimAdapter, type DetailedEvaluation, type OptimContext, type OptimEvent } from "./adapter.ts";
import { closeOptimizerRun, openOptimizerRun } from "./optimizer-run.ts";

export interface OptimizeOptions {
	/** `skill:<name>`, `system_prompt`, `planner_prompt` or `judge_rubric`. */
	target: string;
	/** Defaults to `budgets.optimDefaultUsd`. */
	budgetUsd?: number;
	/** Most rollouts (agent runs and judge-rubric judgements); unlimited when absent. */
	maxRollouts?: number;
	merge?: boolean;
	/** Seed of the candidate-selection RNG; random when absent. */
	seed?: number;
	signal?: AbortSignal;
	onEvent?: (event: OptimizeEvent) => void;
}

export type OptimizeEvent =
	| OptimEvent
	| GepaEvent
	| { type: "start"; optimRunId: string; target: string; budgetUsd: number; cases: { feedback: number; pareto: number; holdout: number } }
	| { type: "phase"; phase: "baseline" | "loop" | "holdout" }
	| { type: "done"; run: OptimRunRow };

export interface OptimizeResult {
	run: OptimRunRow;
	/** The holdout report; null when the optimization was aborted. */
	report: OptimReport | null;
}

function toEvalCase(c: EvalCaseRow): EvalCase {
	return { id: c.id, input: c.input, skill: c.skill, expected: c.expected, referenceFeedback: c.referenceFeedback, sourceRunId: c.sourceRunId };
}

/** The version the optimization starts from: what the next normal run would use. */
function baseVersion(env: EngineEnv, target: OptimTarget, nowIso: string): ArtifactRow {
	const { db, redact, config, skills } = env.deps;
	switch (target.kind) {
		case "skill": {
			const skill = skills.skills.get(target.name);
			if (!skill) {
				throw new NexoError({ code: "SKILL_NOT_FOUND", message: `Unknown skill "${target.name}"`, hint: `Available: ${[...skills.skills.keys()].join(", ") || "(none)"}` });
			}
			return resolveSourcedArtifact(db, "skill", skill.name, redact(skill.content), nowIso);
		}
		case "system_prompt":
			return resolveSourcedArtifact(db, "system_prompt", "default", redact(DEFAULT_SYSTEM_PROMPT), nowIso);
		case "planner_prompt":
			return resolveSourcedArtifact(db, "planner_prompt", "default", redact(DEFAULT_PLANNER_PROMPT), nowIso);
		case "judge_rubric":
			return loadJudgeRubric(db, config, nowIso, redact).artifact;
	}
}

/** Refuses targets nothing can score (D5). */
function assertEvaluator(env: EngineEnv, target: OptimTarget): void {
	const { config, skills } = env.deps;
	if (judgeModels(config).length === 0 && (target.kind === "judge_rubric" || !config.scoring.enabled || (config.scoring.scorers.length === 0 && !(target.kind === "skill" && skills.skills.get(target.name)?.meta.scorers)))) {
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: target.kind === "judge_rubric" ? "Optimizing judge_rubric needs a judge (models.judge)" : `Nothing can score candidates for ${target.key}: no judge and no scorers are configured`,
			hint: 'Set models.judge, for example [{"provider":"google","id":"<model-id>"}], or scoring.scorers (or the skill\'s nexo-scorers file)',
		});
	}
	if (target.kind !== "judge_rubric" && !config.scoring.enabled) {
		throw new NexoError({ code: "CONFIG_INVALID", message: "Optimization needs scoring.enabled", hint: "Set scoring.enabled to true" });
	}
}

/** Throws BUDGET_EXCEEDED when the optimization budget is more than what is left of the daily or monthly budget (D10). */
function assertBudget(env: EngineEnv, budgetUsd: number): void {
	const { db, config } = env.deps;
	const now = env.now();
	checkAdmission(db, config.budgets, now);
	const limits = [
		{ left: config.budgets.dailyUsd - getSpent(db, dayScope(now)), label: "daily", key: "budgets.dailyUsd" },
		{ left: config.budgets.monthlyUsd - getSpent(db, monthScope(now)), label: "monthly", key: "budgets.monthlyUsd" },
	];
	for (const l of limits) {
		if (budgetUsd > l.left + 1e-9) {
			throw new NexoError({
				code: "BUDGET_EXCEEDED",
				message: `The optimization budget of $${budgetUsd.toFixed(2)} is more than what is left of the ${l.label} budget ($${Math.max(0, l.left).toFixed(2)})`,
				hint: `Pass a smaller --budget-usd, or raise ${l.key}`,
				context: { budgetUsd, leftUsd: l.left },
			});
		}
	}
}

/** The eval cases, split (D6). Throws EVAL_SET_TOO_SMALL with the runs that most need review. */
function loadCases(env: EngineEnv, target: OptimTarget, nowIso: string): { feedback: EvalCase[]; pareto: EvalCase[]; holdout: EvalCase[] } {
	const { db, config } = env.deps;
	syncRunEvalCases(db, target, nowIso);
	let cases = listEvalCases(db, target.key);
	if (target.kind === "judge_rubric") {
		cases = cases.filter((c) => {
			const run = c.sourceRunId ? getRun(db, c.sourceRunId) : undefined;
			return run !== undefined && existsSync(run.dirPath) && (c.expected === "done" || c.expected === "not_done");
		});
	}
	const split = { feedback: [] as EvalCase[], pareto: [] as EvalCase[], holdout: [] as EvalCase[] };
	for (const c of cases) split[c.split].push(toEvalCase(c));
	const empty = (["feedback", "pareto", "holdout"] as const).find((s) => split[s].length === 0);
	if (cases.length < config.optimize.minCases || empty) {
		const runsToReview = runsNeedingReview(db, target).map((r) => r.runId);
		throw new NexoError({
			code: "EVAL_SET_TOO_SMALL",
			message:
				cases.length < config.optimize.minCases
					? `Optimizing ${target.key} needs at least ${config.optimize.minCases} eval cases (optimize.minCases); it has ${cases.length}`
					: `Optimizing ${target.key} needs cases in every split; the ${empty} split is empty (${cases.length} cases)`,
			hint:
				(runsToReview.length > 0 ? `Review these runs (done / not done) so they become eval cases: ${runsToReview.join(", ")}. ` : "") +
				(target.kind === "judge_rubric" ? "Judge rubric cases come from reviewed runs that the judge scored." : `Or add cases with \`nexo eval add --target ${target.key} --input "<instruction>"\`.`),
			context: { target: target.key, cases: cases.length, minCases: config.optimize.minCases, runsToReview },
		});
	}
	return split;
}

/**
 * Runs one GEPA optimization in this process (spec §8.2): checks the budget, builds the eval set, evaluates the base on
 * the pareto and holdout splits, runs the loop, rolls the best candidate out on the holdout split and writes the report.
 * Candidates are never made active. Throws (after recording the failure) on errors; an abort returns with status
 * `aborted` and no report.
 */
export async function startOptimization(baseEnv: EngineEnv, options: OptimizeOptions): Promise<OptimizeResult> {
	// Rollouts never prompt: `ask` follows tools.nonInteractiveAsk (spec §7.6).
	const env = createEngineEnv({ ...baseEnv.deps, prompter: nonInteractivePrompter, onEvent: undefined });
	const { db, config, redact, logger } = env.deps;
	const signal = options.signal ?? new AbortController().signal;
	const nowIso = () => env.now().toISOString();
	const recovered = recoverCrashedOptimRuns(db, isPidAlive, nowIso());
	if (recovered.length > 0) logger.warn("marked optimizations of exited processes as aborted", { optim_run_ids: recovered });

	const target = parseOptimTarget(options.target);
	const budgetUsd = options.budgetUsd ?? config.budgets.optimDefaultUsd;
	if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) throw new NexoError({ code: "INVALID_REQUEST", message: "--budget-usd must be a positive number of USD", context: { budgetUsd } });
	if (options.maxRollouts !== undefined && !(Number.isInteger(options.maxRollouts) && options.maxRollouts > 0)) {
		throw new NexoError({ code: "INVALID_REQUEST", message: "--max-rollouts must be a positive integer", context: { maxRollouts: options.maxRollouts } });
	}
	assertEvaluator(env, target);
	assertBudget(env, budgetUsd);
	const cases = loadCases(env, target, nowIso());
	const minibatch = Math.min(MINIBATCH_SIZE, cases.feedback.length);
	const minRollouts = 2 * (cases.pareto.length + cases.holdout.length) + 2 * minibatch;
	if (options.maxRollouts !== undefined && options.maxRollouts < minRollouts) {
		throw new NexoError({
			code: "INVALID_REQUEST",
			message: `--max-rollouts must be at least ${minRollouts}: the base on the pareto (${cases.pareto.length}) and holdout (${cases.holdout.length}) splits, one iteration (${2 * minibatch} on the minibatch and ${cases.pareto.length} on the pareto split) and the winner on the holdout split (${cases.holdout.length})`,
			context: { maxRollouts: options.maxRollouts, minRollouts },
		});
	}
	const base = baseVersion(env, target, nowIso());
	const components = targetComponents(target);
	const baseTexts = textsOf(target, base.content);
	if (Object.values(baseTexts).some((t) => t.length > MAX_CANDIDATE_CHARS)) {
		throw new NexoError({ code: "INVALID_REQUEST", message: `The ${target.key} text is longer than ${MAX_CANDIDATE_CHARS} characters, the most an optimization handles`, context: { target: target.key } });
	}

	assertReflectionFits(target, baseTexts);

	const optimRunId = newId();
	const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
	const optimizer = openOptimizerRun(env, optimRunId, target);
	insertOptimRun(db, {
		id: optimRunId,
		target: target.key,
		status: "running",
		stopReason: null,
		budgetUsd,
		budgetRollouts: options.maxRollouts ?? null,
		spentUsd: 0,
		rollouts: 0,
		merge: options.merge ?? false,
		seed,
		baseArtifactId: base.id,
		bestArtifactId: null,
		dirPath: optimizer.runDir.root,
		reportRef: null,
		judgeKey: null,
		judgeOnly: null,
		holdoutBefore: null,
		holdoutAfter: null,
		promotion: null,
		replacedArtifactId: null,
		promotedAt: null,
		pid: process.pid,
		error: null,
		createdAt: nowIso(),
		endedAt: null,
	});
	const seedRef: CandidateRef = { id: newId(), artifactId: base.id, texts: baseTexts };
	insertOptimCandidate(db, { id: seedRef.id, optimRunId, artifactId: base.id, parentIds: [], iteration: 0, origin: "seed", component: null, minibatch: null, perCase: {}, meanScore: null, meanCostUsd: null, accepted: true, createdAt: nowIso() });
	options.onEvent?.({ type: "start", optimRunId, target: target.key, budgetUsd, cases: { feedback: cases.feedback.length, pareto: cases.pareto.length, holdout: cases.holdout.length } });

	let ownCost = 0;
	let ownUnknown = false;
	const ctx: OptimContext = {
		env,
		optimRunId,
		recorder: optimizer.recorder,
		parentSpanId: optimizer.spanId,
		budget: new RunBudget(budgetUsd),
		signal,
		addCost: (usd, unknown) => {
			ownCost += usd;
			ownUnknown ||= unknown;
		},
		target,
		runsRoot: join(optimizer.runDir.root, "rollouts"),
		phase: "setup",
		reserveUsd: 0,
		rolloutsLeft: options.maxRollouts ?? Number.POSITIVE_INFINITY,
		rollouts: 0,
		onEvent: (event) => {
			updateOptimRun(db, optimRunId, { spentUsd: ctx.budget.spentUsd, rollouts: ctx.rollouts });
			options.onEvent?.(event);
		},
	};
	const adapter = createOptimAdapter(ctx);
	const perCaseOf = (batch: readonly EvalCase[], result: DetailedEvaluation): Record<string, CaseScore> =>
		Object.fromEntries(batch.map((c, i) => [c.id, result.scores[i] ?? { quality: 0, costUsd: 0 }]));
	const artifactOfCandidate = new Map<string, string>([[seedRef.id, base.id]]);
	const finish = (patch: Partial<OptimRunRow>): OptimRunRow => {
		updateOptimRun(db, optimRunId, { spentUsd: ctx.budget.spentUsd, rollouts: ctx.rollouts, endedAt: nowIso(), ...patch });
		const run = getOptimRun(db, optimRunId) as OptimRunRow;
		options.onEvent?.({ type: "done", run });
		return run;
	};

	try {
		options.onEvent?.({ type: "phase", phase: "baseline" });
		let baseline: { pareto: DetailedEvaluation; holdout: DetailedEvaluation };
		try {
			baseline = { pareto: await adapter.evaluate(cases.pareto, seedRef, false, signal), holdout: await adapter.evaluate(cases.holdout, seedRef, false, signal) };
		} catch (error) {
			if (!(error instanceof BudgetStop)) throw error;
			throw new NexoError({
				code: "BUDGET_EXCEEDED",
				message: `The optimization budget does not cover rolling the current version out on the pareto and holdout splits: ${error.message}`,
				hint: "Pass a larger --budget-usd or --max-rollouts, or lower budgets.perRunUsd",
			});
		}
		const seedPareto = perCaseOf(cases.pareto, baseline.pareto);
		const seedMean = meanOf(seedPareto, cases.pareto.map((c) => c.id));
		updateOptimCandidate(db, seedRef.id, { perCase: seedPareto, meanScore: seedMean.quality, meanCostUsd: seedMean.costUsd });
		const dearest = Math.max(0, ...baseline.pareto.scores.map((s) => s.costUsd), ...baseline.holdout.scores.map((s) => s.costUsd));
		ctx.reserveUsd = cases.holdout.length * Math.min(config.budgets.perRunUsd, 2 * dearest);
		ctx.phase = "loop";
		options.onEvent?.({ type: "phase", phase: "loop" });
		const result = await runGepa({
			adapter,
			seed: seedRef,
			seedPareto,
			components,
			feedback: cases.feedback,
			pareto: cases.pareto,
			patience: config.optimize.patience,
			merge: options.merge ?? false,
			rng: mulberry32(seed),
			signal,
			callbacks: {
				createCandidate: (input) => {
					const parentArtifact = artifactOfCandidate.get(input.parentIds[0] as string) ?? base.id;
					const artifact = insertCandidateArtifact(db, base.kind, base.name, redact(contentOf(target, base.content, input.texts)), parentArtifact, nowIso());
					const id = newId();
					artifactOfCandidate.set(id, artifact.id);
					insertOptimCandidate(db, { id, optimRunId, artifactId: artifact.id, parentIds: input.parentIds, iteration: input.iteration, origin: input.origin, component: input.component, minibatch: null, perCase: {}, meanScore: null, meanCostUsd: null, accepted: false, createdAt: nowIso() });
					return { id, artifactId: artifact.id, texts: textsOf(target, artifact.content) };
				},
				recordMinibatch: (id, record, accepted) => updateOptimCandidate(db, id, { minibatch: record, accepted }),
				recordPareto: (id, perCase, accepted) => {
					const mean = meanOf(perCase, cases.pareto.map((c) => c.id));
					updateOptimCandidate(db, id, { perCase, meanScore: mean.quality, meanCostUsd: mean.costUsd, accepted });
				},
				canStartIteration: (): OptimStopReason | null => {
					if (ctx.rolloutsLeft < 2 * minibatch + cases.pareto.length + cases.holdout.length) return "budget_rollouts";
					if (ctx.budget.remainingUsd() - ctx.reserveUsd < config.budgets.perRunUsd) return "budget_usd";
					return null;
				},
				onEvent: (event) => options.onEvent?.(event),
			},
		});
		if (result.stopReason === "aborted" || signal.aborted) throw new NexoError({ code: "INTERNAL", message: "The optimization was aborted" });

		// The report (spec §8.2.5): the base and the best candidate on the holdout split only.
		ctx.phase = "final";
		options.onEvent?.({ type: "phase", phase: "holdout" });
		const bestArtifactId = artifactOfCandidate.get(result.bestId) ?? base.id;
		const best = getArtifact(db, bestArtifactId) as ArtifactRow;
		const before = perCaseOf(cases.holdout, baseline.holdout);
		let after = before;
		let deterministic = baseline.holdout.deterministic.some(Boolean);
		if (bestArtifactId !== base.id) {
			const bestRef: CandidateRef = { id: result.bestId, artifactId: best.id, texts: textsOf(target, best.content) };
			after = {};
			for (const c of cases.holdout) {
				try {
					const one = await adapter.evaluate([c], bestRef, false, signal);
					after[c.id] = one.scores[0] ?? { quality: 0, costUsd: 0 };
					deterministic ||= one.deterministic.some(Boolean);
				} catch (error) {
					if (!(error instanceof BudgetStop)) throw error;
					// A holdout case the budget cannot cover counts against the candidate.
					after[c.id] = { quality: 0, costUsd: 0 };
				}
			}
		}
		const key = judgeKey(config);
		const judgeOnly = target.kind !== "judge_rubric" && !deterministic;
		const holdoutIds = cases.holdout.map((c) => c.id);
		const report = buildReport({
			optimRunId,
			target: target.key,
			baseArtifactId: base.id,
			bestArtifactId,
			baseText: base.content,
			bestText: best.content,
			holdout: cases.holdout.map((c) => ({ caseId: c.id, input: c.input })),
			before,
			after,
			candidates: listOptimCandidates(db, optimRunId),
			evidence: { judgeOnly, humanScored: target.kind === "judge_rubric", judgeKey: key, kappa: key ? liveJudgeKappa(db, key) : null, minJudgeKappa: config.optimize.minJudgeKappa },
			stopReason: result.stopReason,
			spentUsd: ctx.budget.spentUsd,
			rollouts: ctx.rollouts,
			iterations: result.iterations,
			merges: result.merges,
			mergeNote: options.merge && result.merges === 0 && components.length === 1 ? `${target.key} has one component, so no merge is possible` : null,
			createdAt: nowIso(),
		});
		writeFileSync(join(optimizer.runDir.root, "report.json"), `${JSON.stringify(redact(report), null, 2)}\n`);
		retireOptimCandidates(db, optimRunId, bestArtifactId === base.id ? null : bestArtifactId);
		closeOptimizerRun(env, optimizer, { status: "succeeded", costUsd: ownCost, costUnknown: ownUnknown, error: null, output: `best ${bestArtifactId === base.id ? "is the base version" : `v${best.version}`}` });
		const run = finish({
			status: "succeeded",
			stopReason: result.stopReason,
			bestArtifactId,
			reportRef: "report.json",
			judgeKey: key,
			judgeOnly,
			holdoutBefore: meanOf(before, holdoutIds).quality,
			holdoutAfter: meanOf(after, holdoutIds).quality,
		});
		return { run, report };
	} catch (error) {
		const aborted = signal.aborted;
		const payload = redact(toErrorPayload(error));
		retireOptimCandidates(db, optimRunId, null);
		try {
			closeOptimizerRun(env, optimizer, { status: aborted ? "aborted" : "failed", costUsd: ownCost, costUnknown: ownUnknown, error: aborted ? null : payload, output: "" });
		} catch (closeError) {
			logger.error("closing the optimizer run failed", { error: closeError });
		}
		const run = finish({ status: aborted ? "aborted" : "failed", stopReason: aborted ? "aborted" : "error", error: aborted ? null : payload });
		if (aborted) return { run, report: null };
		throw error;
	}
}
