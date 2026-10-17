import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type { ErrorPayload } from "@nexo/telemetry";
import type { Db } from "./db.ts";
import { checkOffset } from "./cursor.ts";
import { invalidRequest } from "./errors.ts";
import type { Verdict } from "./feedback.ts";
import { decodeRunScore, RUN_SCORE_SQL, type RunScore } from "./scores.ts";
import { insertRow, updateById } from "./sql.ts";

export type RunStatus = "running" | "succeeded" | "failed" | "aborted" | "budget_exceeded";

export interface RunRow {
	id: string;
	parentRunId: string | null;
	rootRunId: string;
	dirPath: string;
	instruction: string;
	skill: string | null;
	status: RunStatus;
	configSnapshotHash: string;
	artifactSetId: string | null;
	modelFinal: string | null;
	tierFinal: string | null;
	escalations: number;
	startedAt: string;
	endedAt: string | null;
	costUsd: number;
	costUnknown: boolean;
	tokensIn: number;
	tokensOut: number;
	pid: number | null;
	error: ErrorPayload | null;
	/** Set on the root run of a session turn. */
	sessionId?: string | null;
	turnIndex?: number | null;
	/** Set on optimization rollouts (and their subagents) and on the optimizer's own run row. */
	optimRunId?: string | null;
}

const COLUMNS: Record<keyof RunRow, string> = {
	id: "id",
	parentRunId: "parent_run_id",
	rootRunId: "root_run_id",
	dirPath: "dir_path",
	instruction: "instruction",
	skill: "skill",
	status: "status",
	configSnapshotHash: "config_snapshot_hash",
	artifactSetId: "artifact_set_id",
	modelFinal: "model_final",
	tierFinal: "tier_final",
	escalations: "escalations",
	startedAt: "started_at",
	endedAt: "ended_at",
	costUsd: "cost_usd",
	costUnknown: "cost_unknown",
	tokensIn: "tokens_in",
	tokensOut: "tokens_out",
	pid: "pid",
	error: "error_json",
	sessionId: "session_id",
	turnIndex: "turn_index",
	optimRunId: "optim_run_id",
};

function encode(key: string, value: unknown): SQLInputValue {
	if (key === "costUnknown") return value ? 1 : 0;
	if (key === "error") return value === null || value === undefined ? null : JSON.stringify(value);
	return (value ?? null) as SQLInputValue;
}

function decode(row: Record<string, unknown>): RunRow {
	return {
		id: String(row.id),
		parentRunId: (row.parent_run_id as string | null) ?? null,
		rootRunId: String(row.root_run_id),
		dirPath: String(row.dir_path),
		instruction: String(row.instruction),
		skill: (row.skill as string | null) ?? null,
		status: row.status as RunStatus,
		configSnapshotHash: String(row.config_snapshot_hash),
		artifactSetId: (row.artifact_set_id as string | null) ?? null,
		modelFinal: (row.model_final as string | null) ?? null,
		tierFinal: (row.tier_final as string | null) ?? null,
		escalations: Number(row.escalations),
		startedAt: String(row.started_at),
		endedAt: (row.ended_at as string | null) ?? null,
		costUsd: Number(row.cost_usd),
		costUnknown: Number(row.cost_unknown) === 1,
		tokensIn: Number(row.tokens_in),
		tokensOut: Number(row.tokens_out),
		pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
		error: row.error_json ? (JSON.parse(String(row.error_json)) as ErrorPayload) : null,
		sessionId: (row.session_id as string | null) ?? null,
		turnIndex: row.turn_index === null || row.turn_index === undefined ? null : Number(row.turn_index),
		optimRunId: (row.optim_run_id as string | null) ?? null,
	};
}

export function insertRun(db: Db, row: RunRow, replace = false): void {
	insertRow(db, "runs", COLUMNS, { ...row }, encode, replace);
}

export function updateRun(db: Db, id: string, patch: Partial<Omit<RunRow, "id">>): void {
	updateById(db, "runs", COLUMNS, id, patch, encode);
}

export function getRun(db: Db, id: string): RunRow | undefined {
	const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
	return row ? decode(row) : undefined;
}

export interface RunFilter {
	status?: RunStatus;
	rootOnly?: boolean;
	since?: string;
	limit?: number;
}

export function listRuns(db: Db, filter: RunFilter = {}): RunRow[] {
	const where: string[] = [];
	const args: SQLInputValue[] = [];
	if (filter.status) {
		where.push("status = ?");
		args.push(filter.status);
	}
	if (filter.rootOnly) where.push("parent_run_id IS NULL");
	if (filter.since) {
		where.push("started_at >= ?");
		args.push(filter.since);
	}
	const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC LIMIT ?`;
	return db
		.prepare(sql)
		.all(...args, filter.limit ?? 100)
		.map(decode);
}

export const RUN_STATUSES: readonly RunStatus[] = ["running", "succeeded", "failed", "aborted", "budget_exceeded"];

/** Default and maximum page sizes for `queryRuns`. */
export const DEFAULT_RUN_PAGE = 50;
export const MAX_RUN_PAGE = 200;

/** Longest instruction kept in a run summary; the full text stays in run.json. */
export const SUMMARY_INSTRUCTION_CHARS = 500;

export interface RunSummary {
	id: string;
	parentRunId: string | null;
	rootRunId: string;
	instruction: string;
	skill: string | null;
	status: RunStatus;
	modelFinal: string | null;
	tierFinal: string | null;
	startedAt: string;
	endedAt: string | null;
	costUsd: number;
	costUnknown: boolean;
	tokensIn: number;
	tokensOut: number;
	childCount: number;
	verdict: Verdict | null;
	error: ErrorPayload | null;
	sessionId: string | null;
	turnIndex: number | null;
	/** Title of the run's session, when the session is indexed. */
	sessionTitle: string | null;
	/** The optimization this run belongs to (a rollout or the optimizer's own run); null for ordinary runs. */
	optimRunId: string | null;
	/** The latest scoring round; null when the run was never scored. */
	score: RunScore | null;
}

export interface RunQuery {
	status?: RunStatus;
	skill?: string;
	/** true: runs with feedback. false: finished runs without feedback (the review queue). */
	reviewed?: boolean;
	/** `YYYY-MM-DD` or a UTC ISO timestamp; normalized by `normalizeSince`, then compared against started_at. */
	since?: string;
	limit?: number;
	cursor?: string;
	/** Rows to skip before the page (offset paging; combines with `limit`). */
	offset?: number;
	/** Defaults to true: subagent runs appear inside their root run. */
	rootOnly?: boolean;
	/** Only the turns of this session. */
	sessionId?: string;
	/** true: only one-shot runs, leaving out session turns. */
	oneShot?: boolean;
	/** true: runs with at least one score. false: finished runs without scores. */
	scored?: boolean;
	/** Only the runs of this optimization. Without it, optimization runs (rollouts, the optimizer) are left out. */
	optimRunId?: string;
}

export interface RunPage {
	runs: RunSummary[];
	nextCursor: string | null;
	/** Runs matching the filters, regardless of the page. */
	total: number;
}

const SINCE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;

/**
 * Canonical `YYYY-MM-DDTHH:MM:SS.mmmZ` form of a `since` filter (`YYYY-MM-DD` or a UTC ISO timestamp), so it compares
 * correctly as a string against `started_at`. Impossible dates such as 2026-02-30 are rejected rather than rolled over.
 */
export function normalizeSince(since: string): string {
	const ms = SINCE_RE.test(since) ? Date.parse(since) : Number.NaN;
	const iso = Number.isFinite(ms) ? new Date(ms).toISOString() : "";
	if (iso.slice(0, 10) !== since.slice(0, 10)) {
		throw invalidRequest("since must be YYYY-MM-DD or a UTC ISO timestamp such as 2026-10-10T09:30:00Z", { since });
	}
	return iso;
}

export function isRunStatus(value: unknown): value is RunStatus {
	return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

/** Opaque keyset cursor for the (started_at DESC, id DESC) order. */
export function encodeRunCursor(startedAt: string, id: string): string {
	return Buffer.from(JSON.stringify([startedAt, id])).toString("base64url");
}

export function decodeRunCursor(cursor: string): { startedAt: string; id: string } {
	try {
		const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string") {
			return { startedAt: value[0], id: value[1] };
		}
	} catch {
		// Falls through to the error below.
	}
	throw invalidRequest("cursor is not a cursor returned by this API", { cursor });
}

const SUMMARY_SELECT = `SELECT r.*,
	(SELECT COUNT(*) FROM runs c WHERE c.parent_run_id = r.id) AS child_count,
	(SELECT f.verdict FROM feedback f WHERE f.run_id = r.id ORDER BY f.created_at DESC, f.id DESC LIMIT 1) AS verdict,
	(SELECT s.title FROM sessions s WHERE s.id = r.session_id) AS session_title,
	${RUN_SCORE_SQL} AS score_json
	FROM runs r`;

function decodeSummary(row: Record<string, unknown>): RunSummary {
	const run = decode(row);
	const instruction =
		run.instruction.length > SUMMARY_INSTRUCTION_CHARS ? `${run.instruction.slice(0, SUMMARY_INSTRUCTION_CHARS)}…` : run.instruction;
	return {
		id: run.id,
		parentRunId: run.parentRunId,
		rootRunId: run.rootRunId,
		instruction,
		skill: run.skill,
		status: run.status,
		modelFinal: run.modelFinal,
		tierFinal: run.tierFinal,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		costUsd: run.costUsd,
		costUnknown: run.costUnknown,
		tokensIn: run.tokensIn,
		tokensOut: run.tokensOut,
		childCount: Number(row.child_count ?? 0),
		verdict: (row.verdict as Verdict | null) ?? null,
		error: run.error,
		sessionId: run.sessionId ?? null,
		turnIndex: run.turnIndex ?? null,
		sessionTitle: (row.session_title as string | null) ?? null,
		optimRunId: run.optimRunId ?? null,
		score: decodeRunScore(row.score_json),
	};
}

/** Filtered, keyset-paginated run summaries, newest first. Invalid filters throw INVALID_REQUEST. */
export function queryRuns(db: Db, query: RunQuery = {}): RunPage {
	const limit = query.limit ?? DEFAULT_RUN_PAGE;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUN_PAGE) {
		throw invalidRequest(`limit must be an integer from 1 to ${MAX_RUN_PAGE}`, { limit });
	}
	if (query.status !== undefined && !isRunStatus(query.status)) {
		throw invalidRequest(`status must be one of ${RUN_STATUSES.join(", ")}`, { status: query.status });
	}
	const since = query.since === undefined ? undefined : normalizeSince(query.since);
	const where: string[] = [];
	const args: SQLInputValue[] = [];
	if (query.rootOnly ?? true) where.push("r.parent_run_id IS NULL");
	if (query.status) {
		where.push("r.status = ?");
		args.push(query.status);
	}
	if (query.skill) {
		where.push("r.skill = ?");
		args.push(query.skill);
	}
	if (query.sessionId) {
		where.push("r.session_id = ?");
		args.push(query.sessionId);
	}
	if (query.oneShot) where.push("r.session_id IS NULL");
	if (query.optimRunId) {
		where.push("r.optim_run_id = ?");
		args.push(query.optimRunId);
	} else {
		where.push("r.optim_run_id IS NULL");
	}
	if (since) {
		where.push("r.started_at >= ?");
		args.push(since);
	}
	if (query.reviewed === true) where.push("EXISTS (SELECT 1 FROM feedback f WHERE f.run_id = r.id)");
	if (query.reviewed === false) where.push("r.status != 'running' AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.run_id = r.id)");
	if (query.scored === true) where.push("EXISTS (SELECT 1 FROM scores s WHERE s.run_id = r.id)");
	if (query.scored === false) where.push("r.status != 'running' AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.run_id = r.id)");
	const offset = checkOffset(query.offset);
	const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM runs r ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`).get(...args) as { n: number }).n);
	if (query.cursor !== undefined) {
		const after = decodeRunCursor(query.cursor);
		where.push("(r.started_at < ? OR (r.started_at = ? AND r.id < ?))");
		args.push(after.startedAt, after.startedAt, after.id);
	}
	const sql = `${SUMMARY_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.started_at DESC, r.id DESC LIMIT ? OFFSET ?`;
	const rows = db.prepare(sql).all(...args, limit + 1, offset);
	const runs = rows.slice(0, limit).map(decodeSummary);
	const last = runs.at(-1);
	return { runs, nextCursor: rows.length > limit && last ? encodeRunCursor(last.startedAt, last.id) : null, total };
}

export function getRunSummary(db: Db, id: string): RunSummary | undefined {
	return getRunWithSummary(db, id)?.summary;
}

/** The full row (with `dirPath`) and the summary of one run, read with a single query. */
export function getRunWithSummary(db: Db, id: string): { run: RunRow; summary: RunSummary } | undefined {
	const row = db.prepare(`${SUMMARY_SELECT} WHERE r.id = ?`).get(id);
	return row ? { run: decode(row), summary: decodeSummary(row) } : undefined;
}

export function listChildSummaries(db: Db, parentRunId: string): RunSummary[] {
	return db.prepare(`${SUMMARY_SELECT} WHERE r.parent_run_id = ? ORDER BY r.started_at, r.id`).all(parentRunId).map(decodeSummary);
}

/** Deepest subagent nesting followed by `descendantRunIds`; bounds the walk if the parent links form a loop. */
export const MAX_RUN_DEPTH = 64;

/** The run and all of its descendants (subagents at any depth), the run itself first. A parent loop cannot hang it. */
export function descendantRunIds(db: Db, runId: string): string[] {
	return db
		.prepare(
			`WITH RECURSIVE tree(id, depth) AS (
				SELECT id, 0 FROM runs WHERE id = ?
				UNION SELECT r.id, t.depth + 1 FROM runs r JOIN tree t ON r.parent_run_id = t.id WHERE t.depth < ${MAX_RUN_DEPTH}
			) SELECT id FROM tree GROUP BY id ORDER BY MIN(depth), id`,
		)
		.all(runId)
		.map((row) => String(row.id));
}

export function listChildRuns(db: Db, parentRunId: string): RunRow[] {
	return db.prepare("SELECT * FROM runs WHERE parent_run_id = ? ORDER BY started_at, id").all(parentRunId).map(decode);
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Rewrites `<dir>/run.json` as aborted. A missing or unreadable file is left alone; `nexo reindex` reports unreadable ones. */
function markRunJsonAborted(dir: string, nowIso: string, error: ErrorPayload): void {
	const file = join(dir, "run.json");
	if (!existsSync(file)) return;
	try {
		const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...json, status: "aborted", endedAt: nowIso, error }, null, 2)}\n`);
		renameSync(`${file}.tmp`, file);
	} catch {
		return;
	}
}

/**
 * Marks runs left `running` by processes that no longer exist (runs without a recorded pid are left alone) as `aborted`, in SQLite and in their run.json.
 * Returns the affected ids.
 */
export function recoverCrashedRuns(db: Db, isAlive: (pid: number) => boolean, nowIso: string): string[] {
	const stuck = db.prepare("SELECT id, pid, dir_path FROM runs WHERE status = 'running' AND pid IS NOT NULL").all();
	const ids: string[] = [];
	for (const row of stuck) {
		const pid = Number(row.pid);
		if (isAlive(pid)) continue;
		const error: ErrorPayload = {
			code: "INTERNAL",
			message: `The nexo process (pid ${pid}) exited while this run was running`,
			retryable: false,
		};
		updateRun(db, String(row.id), { status: "aborted", endedAt: nowIso, error });
		markRunJsonAborted(String(row.dir_path), nowIso, error);
		ids.push(String(row.id));
	}
	return ids;
}
