import type { Db } from "@nexo/store";

export type CostDimension = "model" | "tier" | "day" | "run" | "skill";

export interface CostRow {
	key: string;
	costUsd: number;
	calls: number;
	unknownCalls: number;
}

const KEY_SQL: Record<CostDimension, string> = {
	model: "COALESCE(s.provider, '?') || '/' || COALESCE(s.model, '?')",
	tier: "COALESCE(s.tier, 'unknown')",
	day: "substr(s.started_at, 1, 10)",
	run: "r.root_run_id",
	skill: "COALESCE(r.skill, '(none)')",
};

export function costReport(db: Db, options: { by: CostDimension; since: string }): CostRow[] {
	const sql = `SELECT ${KEY_SQL[options.by]} AS key, SUM(s.cost_usd) AS cost, COUNT(*) AS calls, SUM(s.cost_unknown) AS unknown
		FROM spans s JOIN runs r ON r.id = s.run_id
		WHERE s.kind = 'llm_call' AND s.started_at >= ?
		GROUP BY key ORDER BY cost DESC`;
	return db
		.prepare(sql)
		.all(options.since)
		.map((row) => ({ key: String(row.key), costUsd: Number(row.cost), calls: Number(row.calls), unknownCalls: Number(row.unknown) }));
}
