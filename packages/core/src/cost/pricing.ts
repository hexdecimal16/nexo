import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";

export interface CostRates {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface PricedUsage {
	costUsd: number;
	costUnknown: boolean;
}

type AnyModel = Model<any>;

export function modelKey(model: Pick<AnyModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function hasRates(cost: AnyModel["cost"]): boolean {
	return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
}

function withRates(model: AnyModel, rates: CostRates): AnyModel {
	return { ...model, cost: { input: rates.input, output: rates.output, cacheRead: rates.cacheRead ?? 0, cacheWrite: rates.cacheWrite ?? 0 } };
}

function reportedTotal(usage: Usage): number {
	const total = (usage.cost as Usage["cost"] | undefined)?.total;
	return typeof total === "number" ? total : 0;
}

function computeCost(model: AnyModel, usage: Usage): number {
	const copy = structuredClone(usage);
	if (typeof copy.cost !== "object" || copy.cost === null) {
		copy.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	}
	return calculateCost(model, copy).total;
}

function validCost(costUsd: number): PricedUsage {
	return Number.isFinite(costUsd) && costUsd >= 0 ? { costUsd, costUnknown: false } : { costUsd: 0, costUnknown: true };
}

/**
 * Price precedence: pricingOverrides > provider-reported cost > pi model rates; otherwise flagged unknown.
 * A computed cost that is not a finite number >= 0 (for example from a usage with missing fields) is flagged unknown with costUsd 0.
 */
export function priceUsage(model: AnyModel, usage: Usage, overrides: Record<string, CostRates>): PricedUsage {
	const override = overrides[modelKey(model)];
	if (override) return validCost(computeCost(withRates(model, override), usage));
	const reported = reportedTotal(usage);
	if (reported > 0) return validCost(reported);
	if (hasRates(model.cost)) return validCost(computeCost(model, usage));
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return { costUsd: 0, costUnknown: tokens > 0 };
}

/**
 * Upper-bound USD estimate for one request: ceil(chars/4) input tokens plus min(outputTokens, model.maxTokens) output tokens.
 * Returns 0 when no price is known or the result is not a finite number >= 0.
 */
export function estimateCallCostUsd(
	model: AnyModel,
	overrides: Record<string, CostRates>,
	promptChars: number,
	outputTokens: number,
): number {
	const rates = overrides[modelKey(model)] ?? (hasRates(model.cost) ? model.cost : undefined);
	if (!rates) return 0;
	const inputTokens = Math.ceil(promptChars / 4);
	const out = model.maxTokens > 0 ? Math.min(outputTokens, model.maxTokens) : outputTokens;
	const usd = (inputTokens * rates.input + out * rates.output) / 1_000_000;
	return Number.isFinite(usd) && usd >= 0 ? usd : 0;
}
