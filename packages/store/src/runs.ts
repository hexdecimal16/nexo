import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type { ErrorPayload } from "@nexo/telemetry";
import type { Db } from "./db.ts";
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
 * Marks runs left `running` by processes that no longer exist as `aborted`, in SQLite and in their run.json.
 * Returns the affected ids.
 */
export function recoverCrashedRuns(db: Db, isAlive: (pid: number) => boolean, nowIso: string): string[] {
	const stuck = db.prepare("SELECT id, pid, dir_path FROM runs WHERE status = 'running'").all();
	const ids: string[] = [];
	for (const row of stuck) {
		const pid = row.pid === null ? null : Number(row.pid);
		if (pid !== null && isAlive(pid)) continue;
		const error: ErrorPayload = {
			code: "INTERNAL",
			message: `The nexo process (pid ${pid ?? "unknown"}) exited while this run was running`,
			retryable: false,
		};
		updateRun(db, String(row.id), { status: "aborted", endedAt: nowIso, error });
		markRunJsonAborted(String(row.dir_path), nowIso, error);
		ids.push(String(row.id));
	}
	return ids;
}
