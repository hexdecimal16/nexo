import {
	BudgetStop,
	type CandidateRef,
	type ComponentTexts,
	type EvalCase,
	type EvaluationBatch,
	type GepaAdapter,
	type ReflectiveExample,
	textsOf,
} from "@nexo/optimize";
import { type JudgeCaller, judgeScorer, renderTrajectory } from "@nexo/scorers";
import { type ArtifactRow, type CaseScore, getArtifact, getRun, listSpans, type OptimTarget, readRunJson, type ScoreRow } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import { RunBudget } from "../cost/budget.ts";
import { runChargedCompletion } from "../engine/charged-completion.ts";
import { executeRun } from "../engine/run.ts";
import { priceUsage } from "../cost/pricing.ts";
import { summarizeSpans } from "../scoring/runner.ts";
import { judgeModels } from "../scoring/sources.ts";
import { type OptimPayer, optimCharge, proposeText } from "./reflect.ts";

/** Where the optimization is: setting up (base evaluation), in the loop, or rolling out the winner on the holdout split. */
export type OptimPhase = "setup" | "loop" | "final";

export type OptimEvent =
	| { type: "rollout"; caseId: string; candidateId: string; runId: string | null; quality: number; costUsd: number; status: string }
	| { type: "reflection"; candidateId: string; component: string; problem: string | null };

/** The optimization's mutable state that the adapter reads and updates. */
export interface OptimContext extends OptimPayer {
	target: OptimTarget;
	/** Directory rollout runs are created in (`<optim dir>/rollouts`). */
	runsRoot: string;
	phase: OptimPhase;
	/** USD the loop keeps for the winner's holdout rollouts; only enforced in the `loop` phase. */
	reserveUsd: number;
	/** Rollouts still allowed (Infinity without --max-rollouts). */
	rolloutsLeft: number;
	/** Rollouts done (agent runs and judge-rubric judgements). */
	rollouts: number;
	onEvent?: (event: OptimEvent) => void;
}

/** An evaluation with, per case, whether a deterministic scorer contributed to its quality. */
export interface DetailedEvaluation extends EvaluationBatch {
	deterministic: boolean[];
}

export interface OptimAdapter extends GepaAdapter {
	evaluate(batch: readonly EvalCase[], candidate: CandidateRef, captureTraces: boolean, signal: AbortSignal): Promise<DetailedEvaluation>;
}

/**
 * A case's quality from a rollout's latest scoring round: the mean value of its successful deterministic and judge
 * scores; 0 when the run did not succeed or nothing scored it.
 */
export function rolloutQuality(status: string, scores: readonly ScoreRow[]): { quality: number; deterministic: boolean } {
	const used = scores.filter((s) => s.status === "ok" && s.value !== null && (s.scorerKind === "deterministic" || s.scorerKind === "judge"));
	if (status !== "succeeded" || used.length === 0) return { quality: 0, deterministic: false };
	return { quality: used.reduce((sum, s) => sum + (s.value as number), 0) / used.length, deterministic: used.some((s) => s.scorerKind === "deterministic") };
}

/** What the run's scorers see as the reference: the expected answer and the reviewer's feedback. */
export function caseReference(c: EvalCase): string | undefined {
	const parts = [c.expected ? `Reference answer:\n${c.expected}` : "", c.referenceFeedback ? `Reviewer feedback on an earlier attempt:\n${c.referenceFeedback}` : ""].filter(Boolean);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function countRollout(ctx: OptimContext): void {
	if (ctx.rolloutsLeft <= 0) throw new BudgetStop("budget_rollouts", "The rollout budget (--max-rollouts) is spent");
	ctx.rolloutsLeft--;
	ctx.rollouts++;
}

/**
 * Reserves one rollout's budget from the optimization: `budgets.perRunUsd`, which must fit next to the holdout reserve
 * in the setup and loop phases; in the final phase whatever is left, up to `perRunUsd`. Throws BudgetStop.
 */
function reserveRollout(ctx: OptimContext): number {
	const perRun = ctx.env.deps.config.budgets.perRunUsd;
	const free = ctx.budget.remainingUsd() - (ctx.phase === "loop" ? ctx.reserveUsd : 0);
	const amount = ctx.phase === "final" ? Math.min(perRun, free) : perRun;
	if (amount <= 1e-9 || free + 1e-9 < amount || !ctx.budget.tryReserve(amount)) {
		throw new BudgetStop("budget_usd", `The optimization budget has $${Math.max(0, free).toFixed(4)} free, less than a rollout's $${perRun.toFixed(2)} (budgets.perRunUsd)`);
	}
	return amount;
}

/** USD the optimizer's own calls (judgements, reflections) must leave for the winner's holdout rollouts: the reserve, in the loop phase. */
function holdback(ctx: OptimContext): number {
	return ctx.phase === "loop" ? ctx.reserveUsd : 0;
}

/** The context as the payer of reflection calls: reads stay live, and the holdout reserve is held back. */
function optimPayer(ctx: OptimContext): OptimPayer {
	return Object.create(ctx, { holdbackUsd: { value: () => holdback(ctx) } });
}

function artifactOf(ctx: OptimContext, candidate: CandidateRef): ArtifactRow {
	const artifact = getArtifact(ctx.env.deps.db, candidate.artifactId);
	if (!artifact) throw new NexoError({ code: "NOT_FOUND", message: `Candidate artifact ${candidate.artifactId} does not exist` });
	return artifact;
}

function abortIfNeeded(signal: AbortSignal): void {
	if (signal.aborted) throw new NexoError({ code: "INTERNAL", message: "The optimization was aborted" });
}

/** Agent targets: each case is one rollout run with the candidate (spec §8.2, D4). */
async function evaluateAgent(ctx: OptimContext, batch: readonly EvalCase[], candidate: CandidateRef, captureTraces: boolean, signal: AbortSignal): Promise<DetailedEvaluation> {
	const { db } = ctx.env.deps;
	const artifact = artifactOf(ctx, candidate);
	const scores: CaseScore[] = [];
	const deterministic: boolean[] = [];
	const traces: ReflectiveExample[] = [];
	for (const c of batch) {
		abortIfNeeded(signal);
		countRollout(ctx);
		const reserved = reserveRollout(ctx);
		let costUsd = 0;
		try {
			const reference = caseReference(c);
			const result = await executeRun(ctx.env, {
				request: { instruction: c.input, ...(ctx.target.kind === "skill" ? { skill: ctx.target.name } : c.skill ? { skill: c.skill } : {}) },
				budget: new RunBudget(reserved),
				signal,
				rollout: { optimRunId: ctx.optimRunId, runsRoot: ctx.runsRoot, candidate: artifact, ...(reference ? { reference } : {}) },
			});
			costUsd = result.costUsd;
			abortIfNeeded(signal);
			const latest = result.scores ?? [];
			const q = rolloutQuality(result.status, latest);
			scores.push({ quality: q.quality, costUsd });
			deterministic.push(q.deterministic);
			ctx.onEvent?.({ type: "rollout", caseId: c.id, candidateId: candidate.id, runId: result.trajectoryId, quality: q.quality, costUsd, status: result.status });
			if (captureTraces) {
				const spans = result.trajectoryId ? listSpans(db, result.trajectoryId) : [];
				traces.push({
					instruction: c.input,
					status: result.status,
					output: result.output,
					trajectory: renderTrajectory(summarizeSpans(spans)),
					scores: latest.map((s) => ({ name: s.scorerName, value: s.value, passed: s.passed, rationale: s.rationale || s.error?.message || "" })),
					quality: q.quality,
					reference: c.expected,
					feedback: c.referenceFeedback,
				});
			}
		} finally {
			ctx.budget.settleReservation(reserved, costUsd);
		}
	}
	return { scores, traces: captureTraces ? traces : null, deterministic };
}

/** A JudgeCaller whose calls are `judge_call` spans on the optimizer's run, charged to the optimization. */
function optimJudgeCaller(ctx: OptimContext, refused: { hit: boolean }): JudgeCaller {
	return {
		complete: async (ref, request, signal) => {
			const model = ctx.env.registry.get(ref.provider, ref.id);
			return runChargedCompletion(
				{
					env: ctx.env,
					recorder: ctx.recorder,
					budget: ctx.budget,
					holdbackUsd: () => holdback(ctx),
					charge: (m, msg) => {
						const priced = priceUsage(m, msg.usage, ctx.env.deps.config.pricingOverrides);
						optimCharge(ctx, priced.costUsd, priced.costUnknown);
						return priced;
					},
					refused: (estimate) => {
						refused.hit = true;
						return new NexoError({ code: "BUDGET_EXCEEDED", message: `The optimization budget cannot cover a judge call (estimated $${estimate.toFixed(4)})` });
					},
					abortMessage: "The judge call was aborted",
				},
				{ model, system: request.system, user: request.user, effort: "off", span: { kind: "judge_call", name: `${request.purpose} ${model.id}`, parentSpanId: ctx.parentSpanId, tier: "judge", attrs: { purpose: request.purpose } } },
				signal,
			);
		},
	};
}

/**
 * `judge_rubric` (evaluator isolation, D5): no agent runs. Each case's source run is re-judged with the candidate rubric
 * and the quality is 1 when the judge's pass/fail matches the human verdict, else 0. One judgement is one rollout.
 */
async function evaluateRubric(ctx: OptimContext, batch: readonly EvalCase[], candidate: CandidateRef, captureTraces: boolean, signal: AbortSignal): Promise<DetailedEvaluation> {
	const { db, config } = ctx.env.deps;
	const rubric = textsOf(ctx.target, artifactOf(ctx, candidate).content).rubric ?? "";
	const scores: CaseScore[] = [];
	const traces: ReflectiveExample[] = [];
	for (const c of batch) {
		abortIfNeeded(signal);
		countRollout(ctx);
		const run = c.sourceRunId ? getRun(db, c.sourceRunId) : undefined;
		if (!run) throw new NexoError({ code: "NOT_FOUND", message: `The source run of eval case ${c.id} does not exist`, context: { caseId: c.id } });
		let output = "";
		try {
			output = readRunJson(run.dirPath).output ?? "";
		} catch {
			output = "";
		}
		const trajectory = summarizeSpans(listSpans(db, run.id));
		const refused = { hit: false };
		const spentBefore = ctx.budget.spentUsd;
		let quality = 0;
		let judged: { value: number | null; passed: boolean | null; rationale: string } = { value: null, passed: null, rationale: "" };
		try {
			const result = await judgeScorer({ name: "llm_judge", caller: optimJudgeCaller(ctx, refused), models: judgeModels(config), rubric, passThreshold: config.scoring.passThreshold, generators: [] }).score(
				{ runId: run.id, instruction: run.instruction, finalOutput: output, runDir: run.dirPath, workspace: run.dirPath, trajectory },
				signal,
			);
			// A panel member whose call was refused is dropped by the scorer, which still returns; the evaluation stops instead.
			if (refused.hit) throw new BudgetStop("budget_usd", "The optimization budget cannot cover another judge call");
			judged = { value: result.value, passed: result.passed, rationale: result.rationale };
			quality = result.passed === (c.expected === "done") ? 1 : 0;
		} catch (error) {
			abortIfNeeded(signal);
			if (refused.hit) throw new BudgetStop("budget_usd", "The optimization budget cannot cover another judge call");
			judged = { value: null, passed: null, rationale: error instanceof Error ? error.message : String(error) };
		}
		const costUsd = ctx.budget.spentUsd - spentBefore;
		scores.push({ quality, costUsd });
		ctx.onEvent?.({ type: "rollout", caseId: c.id, candidateId: candidate.id, runId: null, quality, costUsd, status: "judged" });
		if (captureTraces) {
			traces.push({
				instruction: run.instruction,
				status: "judged",
				output,
				trajectory: renderTrajectory(trajectory),
				scores: [{ name: "llm_judge with this rubric", ...judged }],
				quality,
				reference: `The human verdict is ${c.expected === "done" ? "done (the judge should pass it)" : "not done (the judge should fail it)"}`,
				feedback: c.referenceFeedback,
			});
		}
	}
	return { scores, traces: captureTraces ? traces : null, deterministic: batch.map(() => false) };
}

/** The GepaAdapter of an optimization (spec §8.2.8): rollouts, reflective datasets and reflection proposals. */
export function createOptimAdapter(ctx: OptimContext): OptimAdapter {
	const payer = optimPayer(ctx);
	return {
		evaluate: (batch, candidate, captureTraces, signal) =>
			ctx.target.kind === "judge_rubric" ? evaluateRubric(ctx, batch, candidate, captureTraces, signal) : evaluateAgent(ctx, batch, candidate, captureTraces, signal),
		makeReflectiveDataset: (_candidate, evalBatch, components) => Object.fromEntries(components.map((c) => [c, evalBatch.traces ?? []])),
		proposeNewTexts: async (candidate, dataset, components) => {
			const texts: ComponentTexts = {};
			for (const component of components) {
				const proposal = await proposeText(payer, { target: ctx.target, component, currentText: candidate.texts[component] ?? "", examples: dataset[component] ?? [] });
				const problem = "problem" in proposal ? proposal.problem : null;
				ctx.onEvent?.({ type: "reflection", candidateId: candidate.id, component, problem });
				if ("problem" in proposal) return null;
				texts[component] = proposal.text;
			}
			return texts;
		},
	};
}
