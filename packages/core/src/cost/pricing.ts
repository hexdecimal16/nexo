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

/** Price precedence: pricingOverrides > provider-reported cost > pi model rates; otherwise flagged unknown. */
export function priceUsage(model: AnyModel, usage: Usage, overrides: Record<string, CostRates>): PricedUsage {
	const override = overrides[modelKey(model)];
	if (override) return { costUsd: calculateCost(withRates(model, override), structuredClone(usage)).total, costUnknown: false };
	if (usage.cost.total > 0) return { costUsd: usage.cost.total, costUnknown: false };
	if (hasRates(model.cost)) return { costUsd: calculateCost(model, structuredClone(usage)).total, costUnknown: false };
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return { costUsd: 0, costUnknown: tokens > 0 };
}

/** Upper-bound USD estimate for one request: ceil(chars/4) input tokens plus min(outputTokens, model.maxTokens) output tokens. */
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
	return (inputTokens * rates.input + out * rates.output) / 1_000_000;
}
