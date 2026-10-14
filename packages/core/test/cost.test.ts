import type { Model, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { NexoError } from "@nexo/telemetry";
import { addSpend, dayScope, getSpent, monthScope, openDb } from "@nexo/store";
import { budgetExhaustedError, budgetLine, checkAdmission, estimateCallCostUsd, priceUsage, recordSpend, RunBudget, runBudgetLimit } from "../src/index.ts";

function model(cost: Partial<Model<string>["cost"]> = {}, maxTokens = 1000): Model<string> {
	return {
		id: "m",
		name: "m",
		api: "faux",
		provider: "p",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost },
		contextWindow: 100_000,
		maxTokens,
	};
}

function usage(input: number, output: number, reportedTotal = 0): Usage {
	return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: reportedTotal } };
}

describe("priceUsage", () => {
	it("uses the provider-reported cost when present", () => {
		expect(priceUsage(model({ input: 1 }), usage(1000, 0, 0.5), {})).toEqual({ costUsd: 0.5, costUnknown: false });
	});

	it("computes from model rates when the provider reports zero, without mutating the usage", () => {
		const u = usage(1_000_000, 500_000);
		expect(priceUsage(model({ input: 3, output: 15 }), u, {})).toEqual({ costUsd: 10.5, costUnknown: false });
		expect(u.cost.total).toBe(0);
	});

	it("prefers pricingOverrides", () => {
		expect(priceUsage(model({ input: 3 }), usage(1_000_000, 0, 9), { "p/m": { input: 1, output: 0 } }).costUsd).toBe(1);
	});

	it("flags unknown cost when tokens were used but no price exists", () => {
		expect(priceUsage(model(), usage(10, 10), {})).toEqual({ costUsd: 0, costUnknown: true });
		expect(priceUsage(model(), usage(0, 0), {})).toEqual({ costUsd: 0, costUnknown: false });
	});
});

describe("estimateCallCostUsd", () => {
	it("bounds input by chars/4 and output by min(outputTokens, maxTokens)", () => {
		const m = model({ input: 1_000_000, output: 2_000_000 }, 10);
		expect(estimateCallCostUsd(m, {}, 8, 4096)).toBeCloseTo(2 * 1 + 10 * 2);
		expect(estimateCallCostUsd(model(), {}, 8, 10)).toBe(0);
	});
});

describe("RunBudget", () => {
	it("tracks spend at and over the limit", () => {
		const b = new RunBudget(1);
		b.charge(1);
		expect(b.isExhausted()).toBe(true);
		expect(b.canAfford(0.000001)).toBe(false);
		b.charge(0.01);
		expect(b.remainingUsd()).toBe(0);
		expect(b.spentUsd).toBeCloseTo(1.01);
	});

	it("reserves for children and settles the unused part", () => {
		const b = new RunBudget(1);
		expect(b.tryReserve(0.6)).toBe(true);
		expect(b.tryReserve(0.6)).toBe(false);
		expect(b.remainingFraction()).toBeCloseTo(0.4);
		b.settleReservation(0.6, 0.25);
		expect(b.remainingUsd()).toBeCloseTo(0.75);
		expect(b.reservedUsd).toBe(0);
	});

	it("formats the budget line shown to the agent", () => {
		const b = new RunBudget(0.5);
		b.charge(0.125);
		expect(budgetLine(b)).toBe("Budget: $0.3750 of $0.50 remaining");
	});
});

describe("admission", () => {
	const now = new Date("2026-10-10T10:00:00.000Z");

	it("caps a run's budget at the smallest of its own, the session's and what is left of the day and month", () => {
		const db = openDb(":memory:");
		const budgets = { dailyUsd: 10, monthlyUsd: 100 };
		expect(runBudgetLimit(db, budgets, now, { run: 0.5 })).toEqual({ usd: 0.5, by: "run" });
		expect(runBudgetLimit(db, budgets, now, { run: 0.5, session: 0.2 })).toEqual({ usd: 0.2, by: "session" });
		addSpend(db, [dayScope(now), monthScope(now)], 9.9, now.toISOString());
		const daily = runBudgetLimit(db, budgets, now, { run: 0.5, session: 0.2 });
		expect(daily.by).toBe("daily");
		expect(daily.usd).toBeCloseTo(0.1);
		addSpend(db, [monthScope(now)], 90.05, now.toISOString());
		const monthly = runBudgetLimit(db, budgets, now, { run: 0.5 });
		expect(monthly.by).toBe("monthly");
		expect(monthly.usd).toBeCloseTo(0.05);
		addSpend(db, [dayScope(now), monthScope(now)], 1, now.toISOString());
		expect(runBudgetLimit(db, budgets, now, { run: 0.5 }).usd).toBe(0);
	});

	it("explains an exhausted budget by the limit that capped it, for chat turns and one-shot runs", () => {
		const budget = new RunBudget(0.5);
		budget.charge(0.42);
		const run = budgetExhaustedError(budget, "run", false);
		expect(run).toMatchObject({ code: "BUDGET_EXCEEDED", message: "Run budget of $0.50 is not enough to continue ($0.4200 spent)", hint: expect.stringContaining("--budget") });
		const turn = budgetExhaustedError(budget, "run", true);
		expect(turn.message).toBe("Turn budget of $0.50 is not enough to continue ($0.4200 spent)");
		expect(turn.hint).toContain("budgets.perRunUsd");
		expect(turn.hint).not.toContain("--budget");
		expect(budgetExhaustedError(budget, "session", true)).toMatchObject({
			message: "Turn budget of $0.50 is not enough to continue ($0.4200 spent; capped by the session's remaining budget)",
			hint: expect.stringContaining("/budget <usd>"),
		});
		expect(budgetExhaustedError(budget, "daily", true).hint).toContain("budgets.dailyUsd");
		expect(budgetExhaustedError(budget, "monthly", false).message).toContain("capped by what is left of the monthly budget");
	});

	it("admits under the limits and records spend to day, month and run scopes", () => {
		const db = openDb(":memory:");
		checkAdmission(db, { dailyUsd: 10, monthlyUsd: 100 }, now);
		recordSpend(db, "root1", 0.2, now);
		expect(getSpent(db, dayScope(now))).toBeCloseTo(0.2);
		expect(getSpent(db, monthScope(now))).toBeCloseTo(0.2);
		expect(getSpent(db, "run:root1")).toBeCloseTo(0.2);
	});

	it.each([
		["day", "budgets.dailyUsd"],
		["month", "budgets.monthlyUsd"],
	])("blocks when the %s ledger is exhausted, naming %s", (scope, key) => {
		const db = openDb(":memory:");
		addSpend(db, [scope === "day" ? dayScope(now) : monthScope(now)], 100, now.toISOString());
		try {
			checkAdmission(db, { dailyUsd: 10, monthlyUsd: 100 }, now);
			expect.unreachable();
		} catch (err) {
			expect((err as NexoError).code).toBe("BUDGET_EXCEEDED");
			expect((err as NexoError).hint).toContain(key);
		}
	});
});

describe("non-finite and negative amounts", () => {
	const now = new Date("2026-10-10T10:00:00.000Z");
	const code = (fn: () => unknown): string | undefined => {
		try {
			fn();
		} catch (err) {
			return (err as NexoError).code;
		}
		return undefined;
	};

	it("flags usage with missing fields as unknown cost", () => {
		const broken = { input: 10, output: 10, cacheRead: undefined, cacheWrite: 0, totalTokens: 20, cost: { total: 0 } } as unknown as Usage;
		expect(priceUsage(model({ input: 3, output: 15 }), broken, {})).toEqual({ costUsd: 0, costUnknown: true });
		const nanReported = usage(10, 10, Number.NaN);
		expect(priceUsage(model(), nanReported, {})).toEqual({ costUsd: 0, costUnknown: true });
	});

	it("never returns NaN from estimateCallCostUsd", () => {
		expect(estimateCallCostUsd(model({ input: 1, output: 1 }), {}, Number.NaN, 10)).toBe(0);
	});

	it("rejects NaN and negative amounts without changing state, and still exhausts", () => {
		const b = new RunBudget(1);
		expect(code(() => b.charge(Number.NaN))).toBe("INTERNAL");
		expect(code(() => b.charge(-1))).toBe("INTERNAL");
		expect(code(() => b.tryReserve(Number.NaN))).toBe("INTERNAL");
		expect(code(() => b.settleReservation(Number.NaN, 0))).toBe("INTERNAL");
		expect(code(() => b.settleReservation(0, -1))).toBe("INTERNAL");
		expect(b.spentUsd).toBe(0);
		expect(b.reservedUsd).toBe(0);
		b.charge(1);
		expect(b.isExhausted()).toBe(true);
	});

	it("releases a reservation even when the actual amount is invalid", () => {
		const b = new RunBudget(1);
		expect(b.tryReserve(0.4)).toBe(true);
		expect(code(() => b.settleReservation(0.4, Number.NaN))).toBe("INTERNAL");
		expect(b.reservedUsd).toBe(0);
		expect(b.spentUsd).toBe(0);
		expect(b.tryReserve(0.6)).toBe(true);
		expect(code(() => b.settleReservation(Number.NaN, 0.1))).toBe("INTERNAL");
		expect(b.reservedUsd).toBeCloseTo(0.6);
	});

	it("rejects bad spend and non-finite limits in admission", () => {
		const db = openDb(":memory:");
		expect(code(() => recordSpend(db, "r", Number.NaN, now))).toBe("INTERNAL");
		expect(code(() => recordSpend(db, "r", -1, now))).toBe("INTERNAL");
		expect(getSpent(db, dayScope(now))).toBe(0);
		expect(code(() => checkAdmission(db, { dailyUsd: Number.NaN, monthlyUsd: 100 }, now))).toBe("CONFIG_INVALID");
		expect(code(() => checkAdmission(db, { dailyUsd: 10, monthlyUsd: Number.NaN }, now))).toBe("CONFIG_INVALID");
	});
});

describe("RunBudget limit and usage without cost", () => {
	it("rejects a non-finite or negative limit", () => {
		for (const limit of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			try {
				new RunBudget(limit);
				expect.unreachable();
			} catch (err) {
				expect((err as NexoError).code).toBe("CONFIG_INVALID");
			}
		}
	});

	it("treats a usage lacking cost as not reported", () => {
		const noCost = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 } as unknown as Usage;
		expect(priceUsage(model({ input: 3 }), noCost, {})).toEqual({ costUsd: 3, costUnknown: false });
		expect(priceUsage(model(), noCost, {})).toEqual({ costUsd: 0, costUnknown: true });
		expect(priceUsage(model(), noCost, { "p/m": { input: 2, output: 0 } })).toEqual({ costUsd: 2, costUnknown: false });
	});
});
