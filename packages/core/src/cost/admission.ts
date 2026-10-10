import { addSpend, type Db, dayScope, getSpent, monthScope } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";

export function checkAdmission(db: Db, budgets: { dailyUsd: number; monthlyUsd: number }, now: Date): void {
	const checks = [
		{ scope: dayScope(now), limit: budgets.dailyUsd, label: "Daily", key: "budgets.dailyUsd", wait: "tomorrow (UTC)" },
		{ scope: monthScope(now), limit: budgets.monthlyUsd, label: "Monthly", key: "budgets.monthlyUsd", wait: "next month (UTC)" },
	];
	for (const c of checks) {
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

export function recordSpend(db: Db, rootRunId: string, usd: number, now: Date): void {
	addSpend(db, [dayScope(now), monthScope(now), `run:${rootRunId}`], usd, now.toISOString());
}
