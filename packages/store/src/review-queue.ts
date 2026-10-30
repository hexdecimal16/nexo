import type { Db } from "./db.ts";

export const DEFAULT_REVIEW_QUEUE_SIZE = 15;

/** Why a run is in the queue. */
export type FailureMode = "failed" | "budget_exceeded" | "aborted" | "low_score" | "unscored" | "ok";

export interface ReviewQueueItem {
	runId: string;
	/** First line of the instruction, at most 120 characters. */
	instruction: string;
	status: string;
	failureMode: FailureMode;
	/** The run's error code when it has one. */
	errorCode: string | null;
	/** Mean of the latest scoring round's successful scores; null when unscored. */
	score: number | null;
	costUsd: number;
	startedAt: string;
}

export interface ReviewQueueOptions {
	/** Most items returned (default 15). */
	limit?: number;
	/** Only runs started in the last `days` days (default 7). */
	days?: number;
	now?: Date;
}

const LOW_SCORE = 0.6;

/**
 * Recent finished root runs that have no human verdict, worst first: failed, over-budget and aborted runs, then low
 * scores, then unscored runs, then the rest by cost. A person reviews the head of this list each week and labels it.
 */
export function reviewQueue(db: Db, options: ReviewQueueOptions = {}): ReviewQueueItem[] {
	const limit = Math.max(1, Math.min(100, options.limit ?? DEFAULT_REVIEW_QUEUE_SIZE));
	const since = new Date((options.now ?? new Date()).getTime() - (options.days ?? 7) * 86_400_000).toISOString();
	const rows = db
		.prepare(
			`SELECT r.id, r.instruction, r.status, r.started_at, r.cost_usd, r.error_json,
				(SELECT AVG(s.value) FROM scores s WHERE s.run_id = r.id AND s.status = 'ok' AND s.round = (SELECT MAX(s2.round) FROM scores s2 WHERE s2.run_id = r.id)) AS score
			FROM runs r
			WHERE r.parent_run_id IS NULL AND r.status != 'running' AND r.started_at >= ?
				AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.run_id = r.id)`,
		)
		.all(since);
	const items = rows.map((row): ReviewQueueItem => {
		const status = String(row.status);
		const score = row.score === null ? null : Number(row.score);
		const failureMode: FailureMode =
			status === "failed" || status === "budget_exceeded" || status === "aborted" ? status : score === null ? "unscored" : score < LOW_SCORE ? "low_score" : "ok";
		let errorCode: string | null = null;
		if (typeof row.error_json === "string") {
			try {
				const code = (JSON.parse(row.error_json) as { code?: unknown }).code;
				errorCode = typeof code === "string" ? code : null;
			} catch {
				errorCode = null;
			}
		}
		const first = String(row.instruction).split("\n")[0] ?? "";
		return {
			runId: String(row.id),
			instruction: first.length > 120 ? `${first.slice(0, 119)}…` : first,
			status,
			failureMode,
			errorCode,
			score,
			costUsd: Number(row.cost_usd),
			startedAt: String(row.started_at),
		};
	});
	const rank: Record<FailureMode, number> = { failed: 0, budget_exceeded: 1, aborted: 2, low_score: 3, unscored: 4, ok: 5 };
	items.sort((a, b) => rank[a.failureMode] - rank[b.failureMode] || (a.score ?? 1) - (b.score ?? 1) || b.costUsd - a.costUsd || b.startedAt.localeCompare(a.startedAt));
	return items.slice(0, limit);
}
