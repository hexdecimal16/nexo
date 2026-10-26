import { addSpend, type Db, dayScope, getSpent, monthScope } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import type { RunBudget } from "./budget.ts";

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

/** The ledger scope of an optimization (spec §5.2). */
export function optimScope(optimRunId: string): string {
	return `optim:${optimRunId}`;
}

/**
 * Adds spend to the day, month and root-run ledger scopes, to `session:<id>` for a session turn and to `optim:<id>` for
 * an optimization rollout.
 */
export function recordSpend(db: Db, rootRunId: string, usd: number, now: Date, sessionId: string | null = null, optimRunId: string | null = null): void {
	if (!Number.isFinite(usd) || usd < 0) {
		throw new NexoError({ code: "INTERNAL", message: `recordSpend received an invalid amount: ${usd}`, context: { rootRunId, usd } });
	}
	const scopes = [dayScope(now), monthScope(now), `run:${rootRunId}`];
	if (sessionId) scopes.push(sessionScope(sessionId));
	if (optimRunId) scopes.push(optimScope(optimRunId));
	addSpend(db, scopes, usd, now.toISOString());
}

/** Which limit set a run's budget: its own (`--budget` / `budgets.perRunUsd`), the session's remainder, or what is left of the day or month. */
export type BudgetLimit = "run" | "session" | "daily" | "monthly";

/**
 * The budget a run may spend: the smallest of its own limit, the session's remaining budget (chat turns) and what is
 * left of the daily and monthly caps, with the limit that set it. Admission only checks the caps when a run starts, so
 * this keeps one run from spending past them.
 */
export function runBudgetLimit(db: Db, budgets: { dailyUsd: number; monthlyUsd: number }, now: Date, limits: { run: number; session?: number }): { usd: number; by: BudgetLimit } {
	const candidates: { usd: number; by: BudgetLimit }[] = [
		{ usd: limits.run, by: "run" },
		...(limits.session !== undefined ? [{ usd: limits.session, by: "session" as const }] : []),
		{ usd: budgets.dailyUsd - getSpent(db, dayScope(now)), by: "daily" },
		{ usd: budgets.monthlyUsd - getSpent(db, monthScope(now)), by: "monthly" },
	];
	let best = candidates[0] as { usd: number; by: BudgetLimit };
	// Ties go to the later (outer) limit: it is the one the user has to raise.
	for (const c of candidates) if (c.usd <= best.usd) best = c;
	return { usd: Math.max(0, best.usd), by: best.by };
}

const CAPPED_BY: Record<Exclude<BudgetLimit, "run">, string> = {
	session: "capped by the session's remaining budget",
	daily: "capped by what is left of the daily budget",
	monthly: "capped by what is left of the monthly budget",
};

/** BUDGET_EXCEEDED for a run whose budget is spent or too small for its next request, naming the limit that set it and the fix that applies (`chat`: a session turn). */
export function budgetExhaustedError(budget: RunBudget, by: BudgetLimit, chat: boolean): NexoError {
	const capped = by === "run" ? "" : `; ${CAPPED_BY[by]}`;
	const hint = {
		run: chat
			? "Each chat turn is capped at budgets.perTurnShare of the session budget; raise the share in /settings or the session cap with /budget"
			: "Pass --budget or raise budgets.perRunUsd",
		session: "Raise the session's budget with /budget <usd>, then continue",
		daily: "Raise budgets.dailyUsd or wait until tomorrow (UTC)",
		monthly: "Raise budgets.monthlyUsd or wait until next month (UTC)",
	}[by];
	return new NexoError({
		code: "BUDGET_EXCEEDED",
		message: `${chat ? "Turn" : "Run"} budget of $${budget.limitUsd.toFixed(2)} is not enough to continue ($${budget.spentUsd.toFixed(4)} spent${capped})`,
		hint,
		context: { limitUsd: budget.limitUsd, spentUsd: budget.spentUsd, limitedBy: by },
	});
}
