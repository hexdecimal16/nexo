import type { SQLInputValue } from "node:sqlite";
import { type ErrorPayload, NexoError } from "@nexo/telemetry";
import { type ArtifactRow, getActiveArtifact, getArtifact } from "./artifacts.ts";
import { type Db, transaction } from "./db.ts";
import { RUNS_TO_REVIEW } from "./eval-cases.ts";
import { agreementStats, confusionMatrix, judgeHumanPairs } from "./judge-calibration.ts";
import { insertRow, updateById } from "./sql.ts";

export type OptimStatus = "running" | "succeeded" | "failed" | "aborted";

/** Why an optimization stopped: a budget, patience, an abort, its process exiting, or an error. */
export type OptimStopReason = "budget_usd" | "budget_rollouts" | "patience" | "aborted" | "process_exited" | "error" | "completed";

/** How a climb ended when it reached an outcome (design §4.3). */
export type ClimbOutcome = "improved" | "golden_raised" | "no_signal" | "not_improved" | "guard_regressed";

/** One candidate's result on one eval case: quality 0..1 and the rollout's cost. */
export interface CaseScore {
	quality: number;
	costUsd: number;
}

export interface OptimRunRow {
	id: string;
	/** `skill:<name>`, `system_prompt`, `planner_prompt` or `judge_rubric`. */
	target: string;
	status: OptimStatus;
	stopReason: OptimStopReason | null;
	budgetUsd: number;
	budgetRollouts: number | null;
	spentUsd: number;
	rollouts: number;
	merge: boolean;
	/** Seed of the candidate-selection RNG. */
	seed: number;
	/** The version that was active when the optimization started (the seed candidate). */
	baseArtifactId: string;
	/** The best candidate on the pareto split; null until the optimization finishes. */
	bestArtifactId: string | null;
	dirPath: string;
	/** The report file, relative to `dirPath`. */
	reportRef: string | null;
	judgeKey: string | null;
	/** True when every quality-bearing holdout score came from the judge. */
	judgeOnly: boolean | null;
	/** Mean holdout quality of the base and of the best candidate. */
	holdoutBefore: number | null;
	holdoutAfter: number | null;
	promotion: "approved" | "rolled_back" | null;
	/** The version the approval retired (rollback reactivates it). */
	replacedArtifactId: string | null;
	promotedAt: string | null;
	pid: number | null;
	error: ErrorPayload | null;
	createdAt: string;
	endedAt: string | null;
	/** `gepa` for `nexo optimize`, `climb` for `nexo optimize climb`. */
	mode: "gepa" | "climb";
	/** The climbed eval case; null for GEPA. */
	caseId: string | null;
	/** The climb's outcome; null for GEPA and for climbs that failed, aborted or ran out of budget. */
	climbOutcome: ClimbOutcome | null;
}

/** A candidate's minibatch comparison with its parent, case by case. */
export interface MinibatchRecord {
	caseIds: string[];
	parent: CaseScore[];
	child: CaseScore[];
}

export interface OptimCandidateRow {
	id: string;
	optimRunId: string;
	artifactId: string;
	/** Candidate ids (not artifact ids) of the parents: none for the seed, one for a reflection, two for a merge. */
	parentIds: string[];
	iteration: number;
	origin: "seed" | "reflect" | "merge";
	component: string | null;
	minibatch: MinibatchRecord | null;
	/** Pareto-split results by eval case id; empty for a rejected candidate. */
	perCase: Record<string, CaseScore>;
	meanScore: number | null;
	meanCostUsd: number | null;
	accepted: boolean;
	createdAt: string;
}

const RUN_COLUMNS: Record<keyof OptimRunRow, string> = {
	id: "id",
	target: "target",
	status: "status",
	stopReason: "stop_reason",
	budgetUsd: "budget_usd",
	budgetRollouts: "budget_rollouts",
	spentUsd: "spent_usd",
	rollouts: "rollouts",
	merge: "merge",
	seed: "seed",
	baseArtifactId: "base_artifact_id",
	bestArtifactId: "best_artifact_id",
	dirPath: "dir_path",
	reportRef: "report_ref",
	judgeKey: "judge_key",
	judgeOnly: "judge_only",
	holdoutBefore: "holdout_before",
	holdoutAfter: "holdout_after",
	promotion: "promotion",
	replacedArtifactId: "replaced_artifact_id",
	promotedAt: "promoted_at",
	pid: "pid",
	error: "error_json",
	createdAt: "created_at",
	endedAt: "ended_at",
	mode: "mode",
	caseId: "case_id",
	climbOutcome: "climb_outcome",
};

const CANDIDATE_COLUMNS: Record<keyof OptimCandidateRow, string> = {
	id: "id",
	optimRunId: "optim_run_id",
	artifactId: "artifact_id",
	parentIds: "parent_ids_json",
	iteration: "iteration",
	origin: "origin",
	component: "component",
	minibatch: "minibatch_json",
	perCase: "per_case_json",
	meanScore: "mean_score",
	meanCostUsd: "mean_cost_usd",
	accepted: "accepted",
	createdAt: "created_at",
};

function encode(key: string, value: unknown): SQLInputValue {
	if (key === "merge" || key === "accepted") return value ? 1 : 0;
	if (key === "judgeOnly") return value === null || value === undefined ? null : value ? 1 : 0;
	if (key === "error" || key === "minibatch") return value === null || value === undefined ? null : JSON.stringify(value);
	if (key === "parentIds" || key === "perCase") return JSON.stringify(value ?? (key === "parentIds" ? [] : {}));
	return (value ?? null) as SQLInputValue;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function decodeRun(row: Record<string, unknown>): OptimRunRow {
	return {
		id: String(row.id),
		target: String(row.target),
		status: row.status as OptimStatus,
		stopReason: (row.stop_reason as OptimStopReason | null) ?? null,
		budgetUsd: Number(row.budget_usd),
		budgetRollouts: num(row.budget_rollouts),
		spentUsd: Number(row.spent_usd),
		rollouts: Number(row.rollouts),
		merge: Number(row.merge) === 1,
		seed: Number(row.seed),
		baseArtifactId: String(row.base_artifact_id),
		bestArtifactId: str(row.best_artifact_id),
		dirPath: String(row.dir_path),
		reportRef: str(row.report_ref),
		judgeKey: str(row.judge_key),
		judgeOnly: row.judge_only === null || row.judge_only === undefined ? null : Number(row.judge_only) === 1,
		holdoutBefore: num(row.holdout_before),
		holdoutAfter: num(row.holdout_after),
		promotion: (row.promotion as OptimRunRow["promotion"]) ?? null,
		replacedArtifactId: str(row.replaced_artifact_id),
		promotedAt: str(row.promoted_at),
		pid: num(row.pid),
		error: row.error_json ? (JSON.parse(String(row.error_json)) as ErrorPayload) : null,
		createdAt: String(row.created_at),
		endedAt: str(row.ended_at),
		mode: row.mode === "climb" ? "climb" : "gepa",
		caseId: str(row.case_id),
		climbOutcome: (row.climb_outcome as ClimbOutcome | null) ?? null,
	};
}

function decodeCandidate(row: Record<string, unknown>): OptimCandidateRow {
	return {
		id: String(row.id),
		optimRunId: String(row.optim_run_id),
		artifactId: String(row.artifact_id),
		parentIds: JSON.parse(String(row.parent_ids_json)) as string[],
		iteration: Number(row.iteration),
		origin: row.origin as OptimCandidateRow["origin"],
		component: str(row.component),
		minibatch: row.minibatch_json ? (JSON.parse(String(row.minibatch_json)) as MinibatchRecord) : null,
		perCase: JSON.parse(String(row.per_case_json)) as Record<string, CaseScore>,
		meanScore: num(row.mean_score),
		meanCostUsd: num(row.mean_cost_usd),
		accepted: Number(row.accepted) === 1,
		createdAt: String(row.created_at),
	};
}

export function insertOptimRun(db: Db, row: OptimRunRow): void {
	insertRow(db, "optim_runs", RUN_COLUMNS, { ...row }, encode);
}

export function updateOptimRun(db: Db, id: string, patch: Partial<Omit<OptimRunRow, "id">>): void {
	updateById(db, "optim_runs", RUN_COLUMNS, id, patch, encode);
}

export function getOptimRun(db: Db, id: string): OptimRunRow | undefined {
	const row = db.prepare("SELECT * FROM optim_runs WHERE id = ?").get(id);
	return row ? decodeRun(row) : undefined;
}

/** Optimizations, newest first. */
export function listOptimRuns(db: Db, options: { limit?: number } = {}): OptimRunRow[] {
	return db.prepare("SELECT * FROM optim_runs ORDER BY created_at DESC, id DESC LIMIT ?").all(options.limit ?? 50).map(decodeRun);
}

export function insertOptimCandidate(db: Db, row: OptimCandidateRow): void {
	insertRow(db, "optim_candidates", CANDIDATE_COLUMNS, { ...row }, encode);
}

export function updateOptimCandidate(db: Db, id: string, patch: Partial<Pick<OptimCandidateRow, "perCase" | "meanScore" | "meanCostUsd" | "accepted" | "minibatch">>): void {
	updateById(db, "optim_candidates", CANDIDATE_COLUMNS, id, patch, encode);
}

/** An optimization's candidates, oldest first. */
export function listOptimCandidates(db: Db, optimRunId: string): OptimCandidateRow[] {
	return db.prepare("SELECT * FROM optim_candidates WHERE optim_run_id = ? ORDER BY created_at, rowid").all(optimRunId).map(decodeCandidate);
}

/** Retires the optimization's candidate artifacts that are still `candidate`, except `keepArtifactId`. Returns how many. */
export function retireOptimCandidates(db: Db, optimRunId: string, keepArtifactId: string | null): number {
	const result = db
		.prepare(
			`UPDATE artifacts SET status = 'retired' WHERE status = 'candidate' AND id != ?
			AND id IN (SELECT artifact_id FROM optim_candidates WHERE optim_run_id = ?)`,
		)
		.run(keepArtifactId ?? "", optimRunId);
	return Number(result.changes);
}

/**
 * Marks optimizations left `running` by processes that no longer exist as `aborted` (stop reason `process_exited`) and
 * retires their candidates. Optimizations without a recorded pid are left alone. Returns the affected ids.
 */
export function recoverCrashedOptimRuns(db: Db, isAlive: (pid: number) => boolean, nowIso: string): string[] {
	const ids: string[] = [];
	for (const row of db.prepare("SELECT id, pid FROM optim_runs WHERE status = 'running' AND pid IS NOT NULL").all()) {
		const pid = Number(row.pid);
		if (isAlive(pid)) continue;
		const id = String(row.id);
		transaction(db, () => {
			updateOptimRun(db, id, {
				status: "aborted",
				stopReason: "process_exited",
				endedAt: nowIso,
				error: { code: "INTERNAL", message: `The nexo process (pid ${pid}) exited while this optimization was running`, retryable: false },
			});
			retireOptimCandidates(db, id, null);
		});
		ids.push(id);
	}
	return ids;
}

/** Root runs scored by `judgeKey` that have no human verdict yet, newest first; reviewing them calibrates the judge. */
export function judgedRunsToReview(db: Db, judgeKey: string, limit = RUNS_TO_REVIEW): string[] {
	return db
		.prepare(
			`SELECT r.id FROM runs r WHERE r.parent_run_id IS NULL AND r.optim_run_id IS NULL
				AND EXISTS (SELECT 1 FROM scores s WHERE s.run_id = r.id AND s.scorer_type = 'llm_judge' AND s.status = 'ok' AND s.model = ?)
				AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.run_id = r.id)
			ORDER BY r.started_at DESC, r.id DESC LIMIT ?`,
		)
		.all(judgeKey, limit)
		.map((row) => String(row.id));
}

/** Cohen's κ of `judgeKey` against the current human verdicts; null without pairs or variation. */
export function liveJudgeKappa(db: Db, judgeKey: string): number | null {
	return agreementStats(confusionMatrix(judgeHumanPairs(db, judgeKey))).kappa;
}

export interface PromotionCheck {
	allowed: boolean;
	/** Why approval is refused (CONFLICT or FORBIDDEN); null when allowed. */
	error: ErrorPayload | null;
	/** The judge's live κ when the evidence is judge-only; null otherwise or when it has none. */
	kappa: number | null;
}

function refusal(code: "CONFLICT" | "FORBIDDEN", message: string, hint: string, context: Record<string, unknown>): ErrorPayload {
	return new NexoError({ code, message, hint, context }).toPayload();
}

/**
 * Whether an optimization's best candidate may be promoted (spec §8.2.6): the optimization succeeded, found a candidate
 * other than the base that is still a candidate, is not approved yet, whose target is still on the base version, and did not get worse on the holdout split; and,
 * when the holdout evidence is judge-only, the judge's live κ is at least `minJudgeKappa`.
 */
export function checkPromotion(db: Db, run: OptimRunRow, minJudgeKappa: number): PromotionCheck {
	const deny = (error: ErrorPayload, kappa: number | null = null): PromotionCheck => ({ allowed: false, error, kappa });
	const ctx = { optimRunId: run.id };
	if (run.status !== "succeeded") return deny(refusal("CONFLICT", `Optimization ${run.id} is ${run.status}, not succeeded`, "Only a finished optimization with a report can be approved", ctx));
	if (run.promotion === "approved") return deny(refusal("CONFLICT", `Optimization ${run.id} is already approved`, `Roll it back with \`nexo optimize rollback ${run.id}\``, ctx));
	if (!run.bestArtifactId || run.bestArtifactId === run.baseArtifactId) {
		return deny(refusal("CONFLICT", `Optimization ${run.id} found nothing better than the version it started from`, "Run another optimization with a larger budget or more eval cases", ctx));
	}
	const best = getArtifact(db, run.bestArtifactId);
	if (!best || best.status !== "candidate") {
		return deny(refusal("CONFLICT", `The best candidate of optimization ${run.id} is ${best?.status ?? "missing"}, not a candidate`, "It was approved or retired already", ctx));
	}
	const active = getActiveArtifact(db, best.kind, best.name);
	if (active?.id !== run.baseArtifactId) {
		return deny(
			refusal(
				"CONFLICT",
				`The target ${run.target} changed since the optimization started: its active version is no longer the one optimization ${run.id} optimized, so approving would override that change`,
				"Run a new optimization against the current version",
				{ ...ctx, baseArtifactId: run.baseArtifactId, activeArtifactId: active?.id ?? null },
			),
		);
	}
	if (run.holdoutBefore !== null && run.holdoutAfter !== null && run.holdoutAfter < run.holdoutBefore) {
		return deny(
			refusal(
				"CONFLICT",
				`The best candidate scored worse on the holdout split (${run.holdoutAfter.toFixed(3)}) than the version it started from (${run.holdoutBefore.toFixed(3)})`,
				"It overfits the training cases; do not promote it",
				{ ...ctx, holdoutBefore: run.holdoutBefore, holdoutAfter: run.holdoutAfter },
			),
		);
	}
	if (!run.judgeOnly) return { allowed: true, error: null, kappa: null };
	const key = run.judgeKey ?? "(no judge)";
	const kappa = run.judgeKey ? liveJudgeKappa(db, run.judgeKey) : null;
	if (kappa !== null && kappa >= minJudgeKappa) return { allowed: true, error: null, kappa };
	const runsToReview = run.judgeKey ? judgedRunsToReview(db, run.judgeKey) : [];
	const why =
		kappa === null
			? `the judge ${key} has no Cohen's κ against your verdicts yet`
			: `the judge ${key} agrees with your verdicts at Cohen's κ ${kappa.toFixed(2)}, below optimize.minJudgeKappa (${minJudgeKappa})`;
	return deny(
		refusal(
			"FORBIDDEN",
			`Promotion refused: the holdout evidence comes only from the judge, and ${why}`,
			runsToReview.length > 0
				? `Review these judged runs (done / not done) to calibrate the judge, then approve again: ${runsToReview.join(", ")}`
				: "Review more judged runs (done / not done) to calibrate the judge, then approve again",
			{ ...ctx, judgeKey: run.judgeKey, kappa, minJudgeKappa, runsToReview },
		),
		kappa,
	);
}

/**
 * Promotes an optimization's best candidate (a user action): in one transaction the target's active version is retired
 * and the candidate becomes active, and the replaced version is recorded for rollback. Throws NOT_FOUND, or the
 * CONFLICT / FORBIDDEN refusal of `checkPromotion`.
 */
export function approveOptimRun(db: Db, id: string, options: { minJudgeKappa: number; nowIso: string }): { promoted: ArtifactRow; replaced: ArtifactRow | null } {
	return transaction(db, () => {
		const run = getOptimRun(db, id);
		if (!run) throw new NexoError({ code: "NOT_FOUND", message: `Optimization ${id} does not exist`, context: { optimRunId: id } });
		const check = checkPromotion(db, run, options.minJudgeKappa);
		if (check.error) throw new NexoError({ ...check.error });
		const best = getArtifact(db, run.bestArtifactId as string) as ArtifactRow;
		const active = getActiveArtifact(db, best.kind, best.name);
		if (active) db.prepare("UPDATE artifacts SET status = 'retired' WHERE id = ?").run(active.id);
		db.prepare("UPDATE artifacts SET status = 'active' WHERE id = ?").run(best.id);
		updateOptimRun(db, id, { promotion: "approved", replacedArtifactId: active?.id ?? null, promotedAt: options.nowIso });
		return { promoted: { ...best, status: "active" }, replaced: active ? { ...active, status: "retired" } : null };
	});
}

/**
 * Undoes an approval (a user action): the promoted version is retired and the version it replaced is active again.
 * Throws NOT_FOUND, or CONFLICT when the optimization was not approved or its promoted version is no longer active.
 */
export function rollbackOptimRun(db: Db, id: string, nowIso: string): { active: ArtifactRow | null; retired: ArtifactRow } {
	return transaction(db, () => {
		const run = getOptimRun(db, id);
		if (!run) throw new NexoError({ code: "NOT_FOUND", message: `Optimization ${id} does not exist`, context: { optimRunId: id } });
		if (run.promotion !== "approved" || !run.bestArtifactId) {
			throw new NexoError({ code: "CONFLICT", message: `Optimization ${id} is not approved, so there is nothing to roll back`, context: { optimRunId: id, promotion: run.promotion } });
		}
		const promoted = getArtifact(db, run.bestArtifactId) as ArtifactRow;
		if (promoted.status !== "active") {
			throw new NexoError({
				code: "CONFLICT",
				message: `The version optimization ${id} promoted (v${promoted.version}) is no longer active`,
				hint: "A newer version replaced it (an edit of its source or another approval); nothing was changed",
				context: { optimRunId: id, artifactId: promoted.id, status: promoted.status },
			});
		}
		db.prepare("UPDATE artifacts SET status = 'retired' WHERE id = ?").run(promoted.id);
		const replaced = run.replacedArtifactId ? getArtifact(db, run.replacedArtifactId) : undefined;
		if (replaced) db.prepare("UPDATE artifacts SET status = 'active' WHERE id = ?").run(replaced.id);
		updateOptimRun(db, id, { promotion: "rolled_back", promotedAt: nowIso });
		return { active: replaced ? { ...replaced, status: "active" } : null, retired: { ...promoted, status: "retired" } };
	});
}
