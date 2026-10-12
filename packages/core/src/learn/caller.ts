import { repairPrompt, validateReply } from "@nexo/memory";
import { addSpend, type Db, dayScope, getSpent, monthScope } from "@nexo/store";
import { NexoError, toErrorPayload } from "@nexo/telemetry";
import type { Static, TSchema } from "typebox";
import type { NexoConfig } from "../config/schema.ts";
import { RunBudget } from "../cost/budget.ts";
import { priceUsage } from "../cost/pricing.ts";
import { runChargedCompletion } from "../engine/charged-completion.ts";
import type { Recorder } from "../engine/recorder.ts";
import type { EngineEnv } from "../engine/run.ts";
import { type EmbeddingEndpoint, embeddingCost, embedTexts, estimateEmbeddingUsd, type FetchLike, reflectorModelSpec } from "./embedder.ts";

/**
 * The budget of one learn job: `learning.perJobUsd`, capped by what is left of the daily and monthly budgets. Throws
 * retryable BUDGET_EXCEEDED when either budget is spent (spec §8.1: learning is charged to the daily budget).
 */
export function learnBudget(db: Db, config: NexoConfig, now: Date): RunBudget {
	const day = config.budgets.dailyUsd - getSpent(db, dayScope(now));
	const month = config.budgets.monthlyUsd - getSpent(db, monthScope(now));
	const limit = Math.min(config.learning.perJobUsd, day, month);
	if (!(limit > 0)) {
		const which = day <= month ? "daily (budgets.dailyUsd)" : "monthly (budgets.monthlyUsd)";
		throw new NexoError({
			code: "BUDGET_EXCEEDED",
			message: `The ${which} budget has nothing left for learning`,
			retryable: true,
			hint: "Run `nexo learn --retry` after the budget resets, or raise the budget",
			context: { dailyLeftUsd: day, monthlyLeftUsd: month },
		});
	}
	return new RunBudget(limit);
}

/** Where a learn call records and charges itself. */
export interface ChargedCallDeps {
	env: EngineEnv;
	recorder: Recorder;
	parentSpanId: string;
	budget: RunBudget;
	/** Called with each call's priced cost after the reservation is settled. */
	charge: (usd: number, unknown: boolean) => void;
	signal: AbortSignal;
	fetch?: FetchLike;
}

/** Charges learning spend to the day and month ledgers only (not the run, root-run or session scopes). */
export function ledgerCharge(db: Db, now: () => Date): (usd: number) => void {
	return (usd) => addSpend(db, [dayScope(now()), monthScope(now())], usd, now().toISOString());
}

function refused(what: string, estimate: number, budget: RunBudget): NexoError {
	return new NexoError({
		code: "BUDGET_EXCEEDED",
		message: `The learning budget cannot cover the ${what} call (estimated $${estimate.toFixed(4)}, $${budget.remainingUsd().toFixed(4)} left)`,
		retryable: true,
		hint: "Raise learning.perJobUsd, or run `nexo learn --retry` after the daily budget resets",
	});
}

/**
 * One reflector or curator completion on the `models.reflector` model (`runChargedCompletion`): each attempt reserves
 * its estimate from the job budget and is a `learn_call` span with tier `reflector` or `curator`; the priced reply is
 * charged to the job budget and through `deps.charge` (the day and month ledgers).
 */
export async function learnCompletion(deps: ChargedCallDeps, request: { system: string; user: string; tier: "reflector" | "curator"; purpose: string }): Promise<string> {
	const { env, budget } = deps;
	const { config } = env.deps;
	const spec = reflectorModelSpec(config);
	const model = env.registry.get(spec.provider, spec.id);
	const effort = env.registry.clampEffort(model, (spec.effort as never) ?? "off");
	const { text } = await runChargedCompletion(
		{
			env,
			recorder: deps.recorder,
			budget,
			charge: (m, msg) => {
				const priced = priceUsage(m, msg.usage, config.pricingOverrides);
				budget.charge(priced.costUsd);
				deps.charge(priced.costUsd, priced.costUnknown);
				return priced;
			},
			refused: (estimate) => refused(request.tier, estimate, budget),
			abortMessage: `The ${request.tier} call was aborted`,
		},
		{
			model,
			system: request.system,
			user: request.user,
			effort,
			span: { kind: "learn_call", name: `${request.purpose} ${model.id}`, parentSpanId: deps.parentSpanId, tier: request.tier, attrs: { purpose: request.purpose } },
		},
		deps.signal,
	);
	return text;
}

/**
 * A completion whose reply must match `schema`: one repair request quotes the invalid reply and the validation errors;
 * a second invalid reply throws SCORER_FAILED (the structured-output failure, as for the judge).
 */
export async function structuredLearnCall<T extends TSchema>(
	deps: ChargedCallDeps,
	schema: T,
	request: { system: string; user: string; tier: "reflector" | "curator" },
): Promise<Static<T>> {
	const first = await learnCompletion(deps, { ...request, purpose: request.tier });
	const checked = validateReply(schema, first);
	if (checked.ok) return checked.value;
	const second = await learnCompletion(deps, { system: request.system, user: `${request.user}\n\n${repairPrompt(first, checked.errors)}`, tier: request.tier, purpose: `${request.tier}-repair` });
	const again = validateReply(schema, second);
	if (again.ok) return again.value;
	throw new NexoError({
		code: "SCORER_FAILED",
		message: `The ${request.tier} reply did not match its schema after one repair: ${again.errors.slice(0, 3).join("; ")}`,
		hint: "Nothing was written. A stronger models.reflector usually fixes this; retry with `nexo learn --retry`",
		context: { tier: request.tier, errors: again.errors },
	});
}

/**
 * Embeds `texts` as one `embedding_call` span (tier `embedding`): the estimate is reserved from `deps.budget`, the key
 * comes from `resolveApiKey(provider)`, and the cost comes from `pricingOverrides` (unknown without one).
 */
export async function embedCharged(deps: ChargedCallDeps, endpoint: EmbeddingEndpoint, texts: readonly string[], purpose: string): Promise<number[][]> {
	if (texts.length === 0) return [];
	const { env, recorder, budget } = deps;
	const { config, redact } = env.deps;
	const estimate = estimateEmbeddingUsd(config, endpoint, texts.reduce((n, t) => n + t.length, 0));
	if (!(estimate > 0 ? budget.tryReserve(estimate) : budget.canAfford(0))) throw refused("embedding", estimate, budget);
	const spanId = recorder.start({
		kind: "embedding_call",
		name: `${purpose} ${endpoint.id}`,
		parentSpanId: deps.parentSpanId,
		model: endpoint.id,
		provider: endpoint.provider,
		tier: "embedding",
		modelSource: "default",
		attrs: { purpose, texts: texts.length },
	});
	let settled = false;
	try {
		const result = await embedTexts(endpoint, texts, { apiKey: env.deps.resolveApiKey?.(endpoint.provider), fetch: deps.fetch, signal: deps.signal });
		const priced = embeddingCost(config, endpoint, result.tokens);
		settled = true;
		if (estimate > 0) budget.settleReservation(estimate, priced.costUsd);
		else budget.charge(priced.costUsd);
		deps.charge(priced.costUsd, priced.costUnknown);
		recorder.finish(spanId, { status: "ok", tokensIn: result.tokens, costUsd: priced.costUsd, costUnknown: priced.costUnknown, attrs: { dim: result.vectors[0]?.length ?? 0, ...(result.tokensEstimated ? { tokensEstimated: true } : {}) } });
		return result.vectors;
	} catch (error) {
		if (!settled && estimate > 0) budget.settleReservation(estimate, 0);
		recorder.finish(spanId, { status: "error", attrs: { error: redact(toErrorPayload(error)) } });
		throw error;
	}
}
