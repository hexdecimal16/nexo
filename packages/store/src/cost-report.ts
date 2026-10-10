import type { Db } from "./db.ts";
import { invalidRequest } from "./errors.ts";

export type CostDimension = "model" | "tier" | "day" | "run" | "skill";

/** The one list of cost dimensions; the CLI, the API and the cost page all take it from here. */
export const COST_DIMENSIONS: readonly CostDimension[] = ["day", "model", "skill", "tier", "run"];

/** `since` defaults to this many days before now. */
export const COST_DEFAULT_DAYS = 30;

export interface CostRow {
	key: string;
	costUsd: number;
	calls: number;
	unknownCalls: number;
}

export interface CostReport {
	by: CostDimension;
	since: string;
	rows: CostRow[];
	totalUsd: number;
	unknownCalls: number;
}

export interface CostReportOptions {
	/** Validated against COST_DIMENSIONS; anything else throws INVALID_REQUEST. */
	by: unknown;
	/** `YYYY-MM-DD`; defaults to COST_DEFAULT_DAYS before `now`. */
	since?: string;
	now?: Date;
}

const KEY_SQL: Record<CostDimension, string> = {
	model: "COALESCE(s.provider, '?') || '/' || COALESCE(s.model, '?')",
	tier: "COALESCE(s.tier, 'unknown')",
	day: "substr(s.started_at, 1, 10)",
	run: "r.root_run_id",
	skill: "COALESCE(r.skill, '(none)')",
};

export function isCostDimension(value: unknown): value is CostDimension {
	return typeof value === "string" && (COST_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * LLM-call spend grouped by one dimension since a date, most expensive first, with totals. Shared by `nexo cost` and
 * the web UI; both pass raw user input, and this function owns the defaults and the validation.
 */
export function costReport(db: Db, options: CostReportOptions): CostReport {
	const by = options.by;
	if (!isCostDimension(by)) {
		throw invalidRequest(`Unknown cost dimension "${String(by)}"`, { by: by ?? null }, `Use one of ${COST_DIMENSIONS.join(", ")}`);
	}
	const now = options.now ?? new Date();
	const since = options.since ?? new Date(now.getTime() - COST_DEFAULT_DAYS * 86_400_000).toISOString().slice(0, 10);
	const ms = /^\d{4}-\d{2}-\d{2}$/.test(since) ? Date.parse(since) : Number.NaN;
	if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== since) {
		throw invalidRequest("since must be a date in the form YYYY-MM-DD", { since });
	}
	const sql = `SELECT ${KEY_SQL[by]} AS key, SUM(s.cost_usd) AS cost, COUNT(*) AS calls, SUM(s.cost_unknown) AS unknown
		FROM spans s JOIN runs r ON r.id = s.run_id
		WHERE s.kind = 'llm_call' AND s.started_at >= ?
		GROUP BY key ORDER BY cost DESC`;
	const rows = db
		.prepare(sql)
		.all(since)
		.map((row) => ({ key: String(row.key), costUsd: Number(row.cost), calls: Number(row.calls), unknownCalls: Number(row.unknown) }));
	return {
		by,
		since,
		rows,
		totalUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
		unknownCalls: rows.reduce((sum, row) => sum + row.unknownCalls, 0),
	};
}
