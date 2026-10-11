import type { SQLInputValue } from "node:sqlite";
import type { ErrorPayload } from "@nexo/telemetry";
import type { Db } from "./db.ts";
import { insertRow } from "./sql.ts";

export type ScorerKind = "deterministic" | "judge" | "human";
export type ScoreStatus = "ok" | "failed";

export interface ScoreCriterion {
	name: string;
	passed: boolean;
	note: string;
}

/** One scorer's result for one scoring round of a run. A failed scorer (`SCORER_FAILED`) has no value and no verdict. */
export interface ScoreRow {
	id: string;
	runId: string;
	round: number;
	scorerKind: ScorerKind;
	/** The scorer spec kind: command, json_schema, regex, contains, llm_judge, human or self_check. */
	scorerType: string;
	scorerName: string;
	status: ScoreStatus;
	value: number | null;
	passed: boolean | null;
	rationale: string;
	criteria: ScoreCriterion[] | null;
	details: Record<string, unknown>;
	error: ErrorPayload | null;
	/** The judge model key (`provider/id`, panel members joined with `+`); null for scorers without a model. */
	model: string | null;
	costUsd: number;
	costUnknown: boolean;
	createdAt: string;
}

/** A run's score in run summaries: the latest round's successful scorers, mean value and all-passed verdict. */
export interface RunScore {
	value: number | null;
	passed: boolean | null;
	scorers: number;
	failedScorers: number;
}

const COLUMNS: Record<keyof ScoreRow, string> = {
	id: "id",
	runId: "run_id",
	round: "round",
	scorerKind: "scorer_kind",
	scorerType: "scorer_type",
	scorerName: "scorer_name",
	status: "status",
	value: "value",
	passed: "passed",
	rationale: "rationale",
	criteria: "criteria_json",
	details: "details_json",
	error: "error_json",
	model: "model",
	costUsd: "cost_usd",
	costUnknown: "cost_unknown",
	createdAt: "created_at",
};

function encode(key: string, value: unknown): SQLInputValue {
	if (key === "costUnknown") return value ? 1 : 0;
	if (key === "passed") return value === null || value === undefined ? null : value ? 1 : 0;
	if (key === "details") return JSON.stringify(value ?? {});
	if (key === "criteria" || key === "error") return value === null || value === undefined ? null : JSON.stringify(value);
	return (value ?? null) as SQLInputValue;
}

function decode(row: Record<string, unknown>): ScoreRow {
	const json = <T>(v: unknown): T | null => (v === null || v === undefined ? null : (JSON.parse(String(v)) as T));
	return {
		id: String(row.id),
		runId: String(row.run_id),
		round: Number(row.round),
		scorerKind: row.scorer_kind as ScorerKind,
		scorerType: String(row.scorer_type),
		scorerName: String(row.scorer_name),
		status: row.status as ScoreStatus,
		value: row.value === null || row.value === undefined ? null : Number(row.value),
		passed: row.passed === null || row.passed === undefined ? null : Number(row.passed) === 1,
		rationale: String(row.rationale ?? ""),
		criteria: json<ScoreCriterion[]>(row.criteria_json),
		details: json<Record<string, unknown>>(row.details_json) ?? {},
		error: json<ErrorPayload>(row.error_json),
		model: (row.model as string | null) ?? null,
		costUsd: Number(row.cost_usd),
		costUnknown: Number(row.cost_unknown) === 1,
		createdAt: String(row.created_at),
	};
}

export function insertScore(db: Db, row: ScoreRow): void {
	insertRow(db, "scores", COLUMNS, { ...row }, encode);
}

/** Every score of a run, by round and then in insertion order. */
export function listScores(db: Db, runId: string): ScoreRow[] {
	return db.prepare("SELECT * FROM scores WHERE run_id = ? ORDER BY round, rowid").all(runId).map(decode);
}

/** Inserts scores taken from run.json during reindex, unless the run already has scores. */
export function restoreScores(db: Db, runId: string, rows: readonly ScoreRow[]): number {
	const existing = Number(db.prepare("SELECT COUNT(*) AS n FROM scores WHERE run_id = ?").get(runId)?.n ?? 0);
	if (existing > 0) return 0;
	let restored = 0;
	for (const row of rows) {
		if (typeof row?.id !== "string" || typeof row.scorerName !== "string") continue;
		insertScore(db, { ...row, runId });
		restored++;
	}
	return restored;
}

/** The SQL expression for `RunScore` of the run aliased `r`, as a JSON object; `scorers` and `failedScorers` are 0 when unscored. */
export const RUN_SCORE_SQL = `(SELECT json_object(
	'value', AVG(CASE WHEN s.status = 'ok' THEN s.value END),
	'passed', MIN(CASE WHEN s.status = 'ok' THEN s.passed END),
	'scorers', SUM(CASE WHEN s.status = 'ok' THEN 1 ELSE 0 END),
	'failedScorers', SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END))
	FROM scores s WHERE s.run_id = r.id AND s.round = (SELECT MAX(s2.round) FROM scores s2 WHERE s2.run_id = r.id))`;

/** Decodes the `RUN_SCORE_SQL` column; null for a run without scores. */
export function decodeRunScore(value: unknown): RunScore | null {
	if (typeof value !== "string") return null;
	const raw = JSON.parse(value) as { value: number | null; passed: number | null; scorers: number | null; failedScorers: number | null };
	const scorers = Number(raw.scorers ?? 0);
	const failedScorers = Number(raw.failedScorers ?? 0);
	if (scorers === 0 && failedScorers === 0) return null;
	return { value: raw.value === null ? null : Number(raw.value), passed: raw.passed === null ? null : Number(raw.passed) === 1, scorers, failedScorers };
}
