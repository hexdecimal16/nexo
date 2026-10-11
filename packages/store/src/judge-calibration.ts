import { createHash } from "node:crypto";
import type { Db } from "./db.ts";
import type { Verdict } from "./feedback.ts";
import { newId } from "./ids.ts";
import { getRun } from "./runs.ts";

/** Eval-case target for judge/human disagreements: they are evidence for the judge rubric. */
export const JUDGE_CASE_TARGET = "judge_rubric";

export type EvalSplit = "feedback" | "pareto" | "holdout";

export interface EvalCaseRow {
	id: string;
	target: string;
	sourceRunId: string | null;
	input: string;
	expected: string | null;
	referenceFeedback: string | null;
	scorerSpec: unknown;
	split: EvalSplit;
	createdAt: string;
}

/** Judge pass/fail against human done/not-done; "positive" is a pass / done. */
export interface ConfusionMatrix {
	/** judge passed, human done */
	bothPass: number;
	/** judge passed, human not done */
	judgePassHumanFail: number;
	/** judge failed, human done */
	judgeFailHumanPass: number;
	/** judge failed, human not done */
	bothFail: number;
}

export interface CalibrationRow {
	id: string;
	judgeKey: string;
	cases: number;
	agreements: number;
	/** null when there are no cases. */
	accuracy: number | null;
	/** Cohen's κ; null when there are no cases or agreement by chance is 1 (every verdict in one class). */
	kappa: number | null;
	matrix: ConfusionMatrix;
	createdAt: string;
}

export interface JudgeHumanPair {
	runId: string;
	judgePassed: boolean;
	verdict: Verdict;
}

/** Stable 40/40/20 feedback/pareto/holdout split by the hash of the source run id (spec §8.2). */
export function evalSplitFor(key: string): EvalSplit {
	const bucket = createHash("sha256").update(key).digest().readUInt32BE(0) % 10;
	return bucket < 4 ? "feedback" : bucket < 8 ? "pareto" : "holdout";
}

/** The latest human verdict and comment of a run. Read here directly, because feedback.ts calls into this module. */
function latestHuman(db: Db, runId: string): { verdict: Verdict; comment: string } | undefined {
	const row = db.prepare("SELECT verdict, comment FROM feedback WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(runId);
	return row ? { verdict: row.verdict as Verdict, comment: String(row.comment) } : undefined;
}

/** The latest round's successful llm_judge verdict of a run, or null. */
export function latestJudgeVerdict(db: Db, runId: string): { passed: boolean; model: string | null } | null {
	const row = db
		.prepare(
			`SELECT passed, model FROM scores WHERE run_id = ? AND scorer_type = 'llm_judge' AND status = 'ok'
			AND round = (SELECT MAX(round) FROM scores WHERE run_id = ?) ORDER BY rowid LIMIT 1`,
		)
		.get(runId, runId);
	if (!row || row.passed === null) return null;
	return { passed: Number(row.passed) === 1, model: (row.model as string | null) ?? null };
}

/** True when the run's latest judge verdict and latest human verdict disagree; false when either is missing. */
export function judgeDisagrees(db: Db, runId: string): boolean {
	const judge = latestJudgeVerdict(db, runId);
	const human = latestHuman(db, runId);
	return judge !== null && human !== undefined && judge.passed !== (human.verdict === "done");
}

function decodeCase(row: Record<string, unknown>): EvalCaseRow {
	return {
		id: String(row.id),
		target: String(row.target),
		sourceRunId: (row.source_run_id as string | null) ?? null,
		input: String(row.input),
		expected: (row.expected as string | null) ?? null,
		referenceFeedback: (row.reference_feedback as string | null) ?? null,
		scorerSpec: row.scorer_spec_json ? JSON.parse(String(row.scorer_spec_json)) : null,
		split: row.split as EvalSplit,
		createdAt: String(row.created_at),
	};
}

export function listEvalCases(db: Db, target: string): EvalCaseRow[] {
	return db.prepare("SELECT * FROM eval_cases WHERE target = ? ORDER BY created_at, id").all(target).map(decodeCase);
}

/**
 * After a human verdict: when the run's judge verdict disagrees, stores (or refreshes) a `judge_rubric` eval case with
 * the human verdict as `expected` and the comment as `reference_feedback`. An existing case is refreshed even when the
 * verdicts now agree, so `expected` always holds the latest human verdict. Returns whether the verdicts disagree.
 */
export function syncJudgeDisagreement(db: Db, runId: string, nowIso: string): boolean {
	const disagrees = judgeDisagrees(db, runId);
	const human = latestHuman(db, runId);
	const run = getRun(db, runId);
	if (!human || !run) return disagrees;
	const existing = db.prepare("SELECT id FROM eval_cases WHERE target = ? AND source_run_id = ?").get(JUDGE_CASE_TARGET, runId);
	if (existing) {
		db.prepare("UPDATE eval_cases SET expected = ?, reference_feedback = ? WHERE id = ?").run(human.verdict, human.comment, String(existing.id));
	} else if (disagrees) {
		db.prepare(
			"INSERT INTO eval_cases (id, target, source_run_id, input, expected, reference_feedback, scorer_spec_json, split, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
		).run(newId(), JUDGE_CASE_TARGET, runId, run.instruction, human.verdict, human.comment, evalSplitFor(runId), nowIso);
	}
	return disagrees;
}

/**
 * Runs that have both a successful judge verdict (latest round) and a human verdict (latest feedback). With `judgeKey`,
 * only verdicts by that judge (score `model`) count.
 */
export function judgeHumanPairs(db: Db, judgeKey?: string): JudgeHumanPair[] {
	const rows = db
		.prepare(
			`SELECT s.run_id AS run_id, s.passed AS passed, s.model AS model,
				(SELECT f.verdict FROM feedback f WHERE f.run_id = s.run_id ORDER BY f.created_at DESC, f.id DESC LIMIT 1) AS verdict
			FROM scores s
			WHERE s.scorer_type = 'llm_judge' AND s.status = 'ok' AND s.passed IS NOT NULL
				AND s.round = (SELECT MAX(s2.round) FROM scores s2 WHERE s2.run_id = s.run_id)
				AND s.rowid = (SELECT MIN(s3.rowid) FROM scores s3 WHERE s3.run_id = s.run_id AND s3.round = s.round AND s3.scorer_type = 'llm_judge' AND s3.status = 'ok')
			ORDER BY s.run_id`,
		)
		.all();
	const pairs: JudgeHumanPair[] = [];
	for (const row of rows) {
		if (row.verdict !== "done" && row.verdict !== "not_done") continue;
		if (judgeKey !== undefined && row.model !== judgeKey) continue;
		pairs.push({ runId: String(row.run_id), judgePassed: Number(row.passed) === 1, verdict: row.verdict });
	}
	return pairs;
}

export function confusionMatrix(pairs: readonly JudgeHumanPair[]): ConfusionMatrix {
	const m: ConfusionMatrix = { bothPass: 0, judgePassHumanFail: 0, judgeFailHumanPass: 0, bothFail: 0 };
	for (const p of pairs) {
		const done = p.verdict === "done";
		if (p.judgePassed && done) m.bothPass++;
		else if (p.judgePassed) m.judgePassHumanFail++;
		else if (done) m.judgeFailHumanPass++;
		else m.bothFail++;
	}
	return m;
}

/** Accuracy and Cohen's κ = (pₒ − pₑ) / (1 − pₑ); κ is null when pₑ = 1 (no variation to agree beyond chance). */
export function agreementStats(m: ConfusionMatrix): { cases: number; agreements: number; accuracy: number | null; kappa: number | null } {
	const cases = m.bothPass + m.judgePassHumanFail + m.judgeFailHumanPass + m.bothFail;
	const agreements = m.bothPass + m.bothFail;
	if (cases === 0) return { cases, agreements, accuracy: null, kappa: null };
	const po = agreements / cases;
	const judgePass = (m.bothPass + m.judgePassHumanFail) / cases;
	const humanPass = (m.bothPass + m.judgeFailHumanPass) / cases;
	const pe = judgePass * humanPass + (1 - judgePass) * (1 - humanPass);
	const kappa = Math.abs(1 - pe) < 1e-12 ? null : (po - pe) / (1 - pe);
	return { cases, agreements, accuracy: po, kappa };
}

/** Computes and stores a calibration of `judgeKey` from the current judge and human verdicts. */
export function recordCalibration(db: Db, judgeKey: string, nowIso: string): CalibrationRow {
	const matrix = confusionMatrix(judgeHumanPairs(db, judgeKey));
	const stats = agreementStats(matrix);
	const row: CalibrationRow = { id: newId(), judgeKey, ...stats, matrix, createdAt: nowIso };
	db.prepare(
		"INSERT INTO judge_calibrations (id, judge_key, cases, agreements, accuracy, kappa, matrix_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(row.id, judgeKey, row.cases, row.agreements, row.accuracy, row.kappa, JSON.stringify(matrix), nowIso);
	return row;
}

function decodeCalibration(row: Record<string, unknown>): CalibrationRow {
	return {
		id: String(row.id),
		judgeKey: String(row.judge_key),
		cases: Number(row.cases),
		agreements: Number(row.agreements),
		accuracy: row.accuracy === null ? null : Number(row.accuracy),
		kappa: row.kappa === null ? null : Number(row.kappa),
		matrix: JSON.parse(String(row.matrix_json)) as ConfusionMatrix,
		createdAt: String(row.created_at),
	};
}

/** Stored calibrations, newest first; with `judgeKey`, only that judge's. */
export function listCalibrations(db: Db, options: { judgeKey?: string; limit?: number } = {}): CalibrationRow[] {
	const limit = options.limit ?? 20;
	const rows =
		options.judgeKey === undefined
			? db.prepare("SELECT * FROM judge_calibrations ORDER BY created_at DESC, id DESC LIMIT ?").all(limit)
			: db.prepare("SELECT * FROM judge_calibrations WHERE judge_key = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(options.judgeKey, limit);
	return rows.map(decodeCalibration);
}

export interface Disagreement {
	runId: string;
	instruction: string;
	judgePassed: boolean;
	verdict: Verdict;
	comment: string;
}

/** Runs whose latest judge verdict disagrees with their latest human verdict (optionally one judge's), newest run first. */
export function listDisagreements(db: Db, options: { judgeKey?: string; limit?: number } = {}): Disagreement[] {
	const out: Disagreement[] = [];
	for (const pair of judgeHumanPairs(db, options.judgeKey)) {
		if (pair.judgePassed === (pair.verdict === "done")) continue;
		const human = latestHuman(db, pair.runId);
		const instruction = db.prepare("SELECT instruction FROM runs WHERE id = ?").get(pair.runId)?.instruction;
		out.push({ runId: pair.runId, instruction: typeof instruction === "string" ? instruction : "", judgePassed: pair.judgePassed, verdict: pair.verdict, comment: human?.comment ?? "" });
	}
	return out.reverse().slice(0, options.limit ?? 50);
}
