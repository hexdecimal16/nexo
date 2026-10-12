import { type Api, type AssistantMessage, type Model, normalizeContext } from "@earendil-works/pi-ai";
import type { Effort } from "@nexo/router";
import type { SpanKind } from "@nexo/store";
import { NexoError, toErrorPayload } from "@nexo/telemetry";
import type { RunBudget } from "../cost/budget.ts";
import { estimateCallCostUsd, type PricedUsage } from "../cost/pricing.ts";
import { classifyProviderError, retryDelayMs } from "./errors.ts";
import { assistantText } from "./messages.ts";
import type { Recorder } from "./recorder.ts";
import type { EngineEnv } from "./run.ts";

/** Who pays for a charged completion and how its failures read. */
export interface ChargedCompletionPayer {
	env: EngineEnv;
	recorder: Recorder;
	/** The budget each attempt's estimate is reserved from. */
	budget: RunBudget;
	/**
	 * Charges one reply after its reservation was released and returns its price: the caller decides which budget, cost
	 * totals and ledgers pay.
	 */
	charge: (model: Model<Api>, msg: AssistantMessage) => PricedUsage;
	/** The error thrown when an attempt's estimate cannot be reserved. */
	refused: (estimateUsd: number) => NexoError;
	/** The message of the error thrown when the call is aborted. */
	abortMessage: string;
}

export interface ChargedCompletionRequest {
	model: Model<Api>;
	system: string;
	user: string;
	effort: Effort;
	/** The span each attempt is recorded as. */
	span: { kind: SpanKind; name: string; parentSpanId: string; tier: string; attrs: Record<string, unknown> };
}

/**
 * One LLM completion outside the agent loop (judge, self-check, reflector, curator). Each attempt reserves its estimate
 * from `payer.budget` (so parallel calls never spend more than the budget together), caps the reply at
 * `budgets.estimateOutputTokens`, streams through the provider gate, releases the reservation, charges the priced reply
 * through `payer.charge` and is recorded as one span. Retryable provider errors are retried like agent turns. Throws
 * `payer.refused(estimate)`, a classified provider error, or INTERNAL on abort.
 */
export async function runChargedCompletion(
	payer: ChargedCompletionPayer,
	request: ChargedCompletionRequest,
	signal: AbortSignal,
): Promise<{ text: string; costUsd: number; costUnknown: boolean }> {
	const { env, recorder, budget } = payer;
	const { config, redact } = env.deps;
	const { model, span } = request;
	const providerCfg = config.providers[model.provider] ?? {};
	const maxRetries = providerCfg.maxRetries ?? 3;
	const baseDelay = providerCfg.retryBaseDelayMs ?? 1000;
	// The reply is capped at the output tokens the estimate assumes, so a verbose reply cannot cost more than was reserved.
	const maxTokens = model.maxTokens > 0 ? Math.min(config.budgets.estimateOutputTokens, model.maxTokens) : config.budgets.estimateOutputTokens;
	let costUsd = 0;
	let costUnknown = false;
	for (let attempt = 1; ; attempt++) {
		const estimate = estimateCallCostUsd(model, config.pricingOverrides, request.system.length + request.user.length, config.budgets.estimateOutputTokens);
		const reserved = estimate > 0 ? budget.tryReserve(estimate) : budget.canAfford(0);
		if (!reserved) throw payer.refused(estimate);
		const spanId = recorder.start({
			kind: span.kind,
			name: span.name,
			parentSpanId: span.parentSpanId,
			model: model.id,
			provider: model.provider,
			tier: span.tier,
			effort: request.effort,
			modelSource: "default",
			attrs: span.attrs,
		});
		let msg: AssistantMessage;
		try {
			const context = normalizeContext({ systemPrompt: request.system, messages: [{ role: "user", content: request.user, timestamp: env.now().getTime() }] });
			const stream = await env.streamFn(model, context, { reasoning: request.effort === "off" ? undefined : request.effort, maxTokens, signal });
			msg = await stream.result();
		} catch (error) {
			if (estimate > 0) budget.settleReservation(estimate, 0);
			recorder.finish(spanId, { status: "error", attrs: { error: redact(toErrorPayload(error)) } });
			throw error;
		}
		if (estimate > 0) budget.settleReservation(estimate, 0);
		const priced = payer.charge(model, msg);
		costUsd += priced.costUsd;
		costUnknown ||= priced.costUnknown;
		const text = assistantText(msg);
		const failed = msg.stopReason === "error" || msg.stopReason === "aborted";
		recorder.finish(spanId, {
			status: failed ? "error" : "ok",
			tokensIn: msg.usage.input,
			tokensOut: msg.usage.output,
			cacheRead: msg.usage.cacheRead,
			cacheWrite: msg.usage.cacheWrite,
			costUsd: priced.costUsd,
			costUnknown: priced.costUnknown,
			attrs: { stopReason: msg.stopReason, errorMessage: msg.errorMessage, reply: redact(text) },
		});
		if (msg.stopReason === "aborted" || signal.aborted) throw new NexoError({ code: "INTERNAL", message: payer.abortMessage });
		if (!failed) return { text, costUsd, costUnknown };
		const error = classifyProviderError(msg.errorMessage ?? "Provider error");
		if (!error.retryable || attempt > maxRetries) throw error;
		await env.sleep(retryDelayMs(attempt, baseDelay, msg.errorMessage ?? ""), signal);
	}
}
