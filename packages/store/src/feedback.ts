import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NexoError, type Redactor } from "@nexo/telemetry";
import type { Db } from "./db.ts";
import { invalidRequest, runNotFound } from "./errors.ts";
import { newId } from "./ids.ts";
import { getRun } from "./runs.ts";

export type Verdict = "done" | "not_done";

export const VERDICTS: readonly Verdict[] = ["done", "not_done"];

/** Longest accepted feedback comment, in characters. */
export const MAX_COMMENT_CHARS = 10_000;

export interface FeedbackRow {
	id: string;
	runId: string;
	verdict: Verdict;
	comment: string;
	createdAt: string;
}

/** The latest human verdict, as stored in run.json (`humanVerdict`). */
export interface HumanVerdict {
	verdict: Verdict;
	comment: string;
	createdAt: string;
}

export interface FeedbackInput {
	runId: string;
	verdict: unknown;
	comment?: unknown;
	nowIso: string;
	redact: Redactor;
}

function decode(row: Record<string, unknown>): FeedbackRow {
	return {
		id: String(row.id),
		runId: String(row.run_id),
		verdict: row.verdict as Verdict,
		comment: String(row.comment),
		createdAt: String(row.created_at),
	};
}

export function isVerdict(value: unknown): value is Verdict {
	return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

/**
 * Validates and stores a human verdict for a finished run, then mirrors the latest verdict into the run's run.json
 * (`humanVerdict`) when the directory still exists. Throws INVALID_REQUEST (bad verdict or comment), NOT_FOUND (unknown
 * run) or CONFLICT (run still running).
 */
export function recordFeedback(db: Db, input: FeedbackInput): FeedbackRow {
	if (!isVerdict(input.verdict)) {
		throw invalidRequest(`verdict must be "done" or "not_done"`, { verdict: input.verdict ?? null });
	}
	const comment = input.comment ?? "";
	if (typeof comment !== "string") throw invalidRequest("comment must be a string");
	if (comment.length > MAX_COMMENT_CHARS) {
		throw invalidRequest(`comment is longer than ${MAX_COMMENT_CHARS} characters`, { length: comment.length });
	}
	const run = getRun(db, input.runId);
	if (!run) throw runNotFound(input.runId);
	if (run.status === "running") {
		throw new NexoError({
			code: "CONFLICT",
			message: `Run ${input.runId} is still running`,
			hint: "Review the run after it finishes",
			context: { runId: input.runId },
		});
	}
	const row: FeedbackRow = {
		id: newId(),
		runId: run.id,
		verdict: input.verdict,
		comment: input.redact(comment.trim()),
		createdAt: input.nowIso,
	};
	db.prepare("INSERT INTO feedback (id, run_id, verdict, comment, created_at) VALUES (?, ?, ?, ?, ?)").run(
		row.id,
		row.runId,
		row.verdict,
		row.comment,
		row.createdAt,
	);
	const latest = latestFeedback(db, run.id) ?? row;
	writeHumanVerdict(run.dirPath, { verdict: latest.verdict, comment: latest.comment, createdAt: latest.createdAt });
	return row;
}

/** All feedback for a run, oldest first. */
export function listFeedback(db: Db, runId: string): FeedbackRow[] {
	return db.prepare("SELECT * FROM feedback WHERE run_id = ? ORDER BY created_at, id").all(runId).map(decode);
}

export function latestFeedback(db: Db, runId: string): FeedbackRow | undefined {
	const row = db.prepare("SELECT * FROM feedback WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(runId);
	return row ? decode(row) : undefined;
}

/** Inserts a feedback row taken from run.json during reindex, unless the run already has feedback. */
export function restoreFeedback(db: Db, runId: string, verdict: HumanVerdict): boolean {
	if (!isVerdict(verdict.verdict) || typeof verdict.createdAt !== "string" || latestFeedback(db, runId)) return false;
	db.prepare("INSERT INTO feedback (id, run_id, verdict, comment, created_at) VALUES (?, ?, ?, ?, ?)").run(
		newId(),
		runId,
		verdict.verdict,
		typeof verdict.comment === "string" ? verdict.comment : "",
		verdict.createdAt,
	);
	return true;
}

/**
 * Mirrors `verdict` into run.json as `humanVerdict` with a read-compare-write: a verdict already in the file with a
 * newer `createdAt` (written by another process) is kept. The feedback table stays authoritative; run.json is a copy
 * that `reindex` reads back. A missing run.json is left alone and a corrupt one is rewritten. Read and write failures
 * throw STORE_IO.
 */
function writeHumanVerdict(dir: string, verdict: HumanVerdict): void {
	const file = join(dir, "run.json");
	if (!existsSync(file)) return;
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		const text = readFileSync(file, "utf8");
		let json: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
		} catch {
			json = {};
		}
		const current = json.humanVerdict as Partial<HumanVerdict> | null | undefined;
		if (typeof current?.createdAt === "string" && current.createdAt > verdict.createdAt) return;
		writeFileSync(tmp, `${JSON.stringify({ ...json, humanVerdict: verdict }, null, 2)}\n`);
		renameSync(tmp, file);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// the tmp file may not exist
		}
		throw new NexoError({
			code: "STORE_IO",
			message: `Could not write the verdict to ${file}: ${error instanceof Error ? error.message : String(error)}`,
			retryable: true,
			context: { path: file },
		});
	}
}
