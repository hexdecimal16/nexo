import type { Db } from "./db.ts";

export function dayScope(date: Date): string {
	return `day:${date.toISOString().slice(0, 10)}`;
}

export function monthScope(date: Date): string {
	return `month:${date.toISOString().slice(0, 7)}`;
}

export function addSpend(db: Db, scopes: readonly string[], usd: number, nowIso: string): void {
	if (usd <= 0) return;
	const stmt = db.prepare(
		"INSERT INTO budget_ledger (scope, spent_usd, updated_at) VALUES (?, ?, ?) " +
			"ON CONFLICT(scope) DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd, updated_at = excluded.updated_at",
	);
	for (const scope of scopes) stmt.run(scope, usd, nowIso);
}

export function getSpent(db: Db, scope: string): number {
	const row = db.prepare("SELECT spent_usd FROM budget_ledger WHERE scope = ?").get(scope);
	return row ? Number(row.spent_usd) : 0;
}
