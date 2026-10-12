import type { ErrorPayload } from "@nexo/telemetry";
import type { Db } from "./db.ts";
import { transaction } from "./db.ts";
import { invalidRequest } from "./errors.ts";
import { newId } from "./ids.ts";

export type LearnJobKind = "reflect" | "curate" | "score";
export type LearnJobTrigger = "run_end" | "feedback";
export type LearnJobStatus = "pending" | "running" | "succeeded" | "failed";

/** Attempts per job, the first one included (spec §8.1). */
export const MAX_LEARN_ATTEMPTS = 3;

export const LEARN_JOB_STATUSES: readonly LearnJobStatus[] = ["pending", "running", "succeeded", "failed"];

export interface LearnJobRow {
	id: string;
	runId: string;
	kind: LearnJobKind;
	trigger: LearnJobTrigger;
	status: LearnJobStatus;
	attempts: number;
	lastError: ErrorPayload | null;
	claimedBy: string | null;
	claimedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

function decode(row: Record<string, unknown>): LearnJobRow {
	const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
	return {
		id: String(row.id),
		runId: String(row.run_id),
		kind: row.kind as LearnJobKind,
		trigger: row.trigger as LearnJobTrigger,
		status: row.status as LearnJobStatus,
		attempts: Number(row.attempts),
		lastError: row.last_error ? (JSON.parse(String(row.last_error)) as ErrorPayload) : null,
		claimedBy: nullable(row.claimed_by),
		claimedAt: nullable(row.claimed_at),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

/**
 * Adds a pending job for the run, unless one is already pending (that job reads the latest verdict when it runs, so
 * it covers this trigger too). Returns the new job, or null when one was already pending.
 */
export function enqueueLearnJob(db: Db, input: { runId: string; kind?: LearnJobKind; trigger: LearnJobTrigger }, nowIso: string): LearnJobRow | null {
	const id = newId();
	const kind = input.kind ?? "reflect";
	const result = db
		.prepare(
			"INSERT OR IGNORE INTO learn_jobs (id, run_id, kind, trigger, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
		)
		.run(id, input.runId, kind, input.trigger, nowIso, nowIso);
	return Number(result.changes) === 1 ? (getLearnJob(db, id) ?? null) : null;
}

export function getLearnJob(db: Db, id: string): LearnJobRow | undefined {
	const row = db.prepare("SELECT * FROM learn_jobs WHERE id = ?").get(id);
	return row ? decode(row) : undefined;
}

/**
 * Atomically takes the oldest pending job for `workerId` (status running, attempts + 1) in one UPDATE … RETURNING, so
 * two processes on the same database never take the same job. Returns undefined when nothing is pending.
 */
export function claimLearnJob(db: Db, workerId: string, nowIso: string): LearnJobRow | undefined {
	const row = db
		.prepare(
			`UPDATE learn_jobs SET status = 'running', attempts = attempts + 1, claimed_by = ?, claimed_at = ?, updated_at = ?
			 WHERE id = (SELECT id FROM learn_jobs WHERE status = 'pending' ORDER BY created_at, id LIMIT 1) AND status = 'pending'
			 RETURNING *`,
		)
		.get(workerId, nowIso, nowIso);
	return row ? decode(row) : undefined;
}

/** Marks a job this worker holds as succeeded. Returns false when the worker no longer holds it (it was reclaimed). */
export function completeLearnJob(db: Db, id: string, workerId: string, nowIso: string): boolean {
	const r = db
		.prepare("UPDATE learn_jobs SET status = 'succeeded', last_error = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND claimed_by = ?")
		.run(nowIso, id, workerId);
	return Number(r.changes) === 1;
}

/** Marks a job this worker holds as failed with `error`. Returns false when the worker no longer holds it. */
export function failLearnJob(db: Db, id: string, workerId: string, error: ErrorPayload, nowIso: string): boolean {
	const r = db
		.prepare("UPDATE learn_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'running' AND claimed_by = ?")
		.run(JSON.stringify(error), nowIso, id, workerId);
	return Number(r.changes) === 1;
}

/** Puts a job this worker holds back to pending without counting the attempt (the worker stopped before finishing it). */
export function releaseLearnJob(db: Db, id: string, workerId: string, nowIso: string): boolean {
	const r = db
		.prepare(
			"UPDATE learn_jobs SET status = 'pending', attempts = MAX(attempts - 1, 0), claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND claimed_by = ?",
		)
		.run(nowIso, id, workerId);
	return Number(r.changes) === 1;
}

/**
 * Jobs left running by a crashed process (claimed before `staleBeforeIso`) go back to pending, or to failed once they
 * used every attempt. Returns the ids put back to pending and the ids failed.
 */
export function reclaimStaleLearnJobs(db: Db, staleBeforeIso: string, nowIso: string): { pending: string[]; failed: string[] } {
	return transaction(db, () => {
		const abandoned: ErrorPayload = { code: "INTERNAL", message: "The process running this job stopped before it finished", retryable: true };
		const failed = db
			.prepare(
				"UPDATE learn_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE status = 'running' AND claimed_at < ? AND attempts >= ? RETURNING id",
			)
			.all(JSON.stringify(abandoned), nowIso, staleBeforeIso, MAX_LEARN_ATTEMPTS)
			.map((r) => String(r.id));
		const pending = db
			.prepare(
				// A run can have one pending job per kind; a stale job whose run already has a newer pending one is dropped into failed instead.
				`UPDATE OR IGNORE learn_jobs SET status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = ?
				 WHERE status = 'running' AND claimed_at < ? RETURNING id`,
			)
			.all(nowIso, staleBeforeIso)
			.map((r) => String(r.id));
		const leftover = db
			.prepare("UPDATE learn_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE status = 'running' AND claimed_at < ? RETURNING id")
			.all(JSON.stringify(abandoned), nowIso, staleBeforeIso)
			.map((r) => String(r.id));
		return { pending, failed: [...failed, ...leftover] };
	});
}

/** Failed jobs with attempts left go back to pending (`nexo learn --retry`). Returns how many. */
export function retryFailedLearnJobs(db: Db, nowIso: string): number {
	const r = db
		.prepare(
			"UPDATE OR IGNORE learn_jobs SET status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE status = 'failed' AND attempts < ?",
		)
		.run(nowIso, MAX_LEARN_ATTEMPTS);
	return Number(r.changes);
}

/** Jobs by status (or run), newest first. Throws INVALID_REQUEST for a bad status or limit. */
export function listLearnJobs(db: Db, filter: { status?: string; runId?: string; limit?: number } = {}): LearnJobRow[] {
	if (filter.status !== undefined && !(LEARN_JOB_STATUSES as readonly string[]).includes(filter.status)) {
		throw invalidRequest(`status must be one of ${LEARN_JOB_STATUSES.join(", ")}`, { status: filter.status });
	}
	const limit = filter.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalidRequest("limit must be an integer from 1 to 1000", { limit });
	const where: string[] = [];
	const args: string[] = [];
	if (filter.status) {
		where.push("status = ?");
		args.push(filter.status);
	}
	if (filter.runId) {
		where.push("run_id = ?");
		args.push(filter.runId);
	}
	return db
		.prepare(`SELECT * FROM learn_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`)
		.all(...args, limit)
		.map(decode);
}

export function countLearnJobs(db: Db): Record<LearnJobStatus, number> {
	const out: Record<LearnJobStatus, number> = { pending: 0, running: 0, succeeded: 0, failed: 0 };
	for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM learn_jobs GROUP BY status").all()) out[r.status as LearnJobStatus] = Number(r.n);
	return out;
}
