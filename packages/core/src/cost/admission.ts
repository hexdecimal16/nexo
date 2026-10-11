import { addSpend, type Db, dayScope, getSpent, monthScope } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";

export function sessionScope(sessionId: string): string {
	return `session:${sessionId}`;
}

export function checkAdmission(db: Db, budgets: { dailyUsd: number; monthlyUsd: number }, now: Date): void {
	const checks = [
		{ scope: dayScope(now), limit: budgets.dailyUsd, label: "Daily", key: "budgets.dailyUsd", wait: "tomorrow (UTC)" },
		{ scope: monthScope(now), limit: budgets.monthlyUsd, label: "Monthly", key: "budgets.monthlyUsd", wait: "next month (UTC)" },
	];
	for (const c of checks) {
		if (!Number.isFinite(c.limit)) {
			throw new NexoError({
				code: "CONFIG_INVALID",
				message: `${c.label} budget limit is not a finite number: ${c.limit}`,
				hint: `Set ${c.key} to a number in your nexo config`,
				context: { key: c.key, value: c.limit },
			});
		}
		const spent = getSpent(db, c.scope);
		if (spent >= c.limit) {
			throw new NexoError({
				code: "BUDGET_EXCEEDED",
				message: `${c.label} budget of $${c.limit.toFixed(2)} is exhausted ($${spent.toFixed(4)} spent)`,
				hint: `Raise ${c.key} in your nexo config or wait until ${c.wait}`,
				context: { scope: c.scope, limitUsd: c.limit, spentUsd: spent },
			});
		}
	}
}

/** Adds spend to the day, month and root-run ledger scopes, and to `session:<id>` for a session turn. */
export function recordSpend(db: Db, rootRunId: string, usd: number, now: Date, sessionId: string | null = null): void {
	if (!Number.isFinite(usd) || usd < 0) {
		throw new NexoError({ code: "INTERNAL", message: `recordSpend received an invalid amount: ${usd}`, context: { rootRunId, usd } });
	}
	const scopes = [dayScope(now), monthScope(now), `run:${rootRunId}`];
	if (sessionId) scopes.push(sessionScope(sessionId));
	addSpend(db, scopes, usd, now.toISOString());
}
