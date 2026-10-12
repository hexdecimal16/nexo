import { repairPrompt, validateReply } from "@nexo/memory";
import { BudgetStop, ProposalSchema, proposalProblem, type ReflectiveExample, reflectionPrompt, reflectionSystem } from "@nexo/optimize";
import { addSpend, dayScope, monthScope, type OptimTarget } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import { optimScope } from "../cost/admission.ts";
import type { RunBudget } from "../cost/budget.ts";
import { priceUsage } from "../cost/pricing.ts";
import { runChargedCompletion } from "../engine/charged-completion.ts";
import type { Recorder } from "../engine/recorder.ts";
import type { EngineEnv } from "../engine/run.ts";

/** Output tokens a reflection reply is capped at (and its estimate assumes), at most `budgets.estimateOutputTokens`. */
export const REFLECTION_MAX_OUTPUT_TOKENS = 8192;

/** Who pays for the optimizer's own calls (reflection, judge-rubric judgements) and where they are recorded. */
export interface OptimPayer {
	env: EngineEnv;
	optimRunId: string;
	/** The optimizer's run recorder; calls are spans under `parentSpanId`. */
	recorder: Recorder;
	parentSpanId: string;
	/** The optimization budget each call reserves its estimate from. */
	budget: RunBudget;
	signal: AbortSignal;
	/** Adds one call's priced cost to the optimizer's own totals. */
	addCost: (usd: number, unknown: boolean) => void;
}

/** Charges a call to the optimization budget, the day, month and `optim:<id>` ledgers and the optimizer's totals. */
export function optimCharge(payer: OptimPayer, usd: number, unknown: boolean): void {
	const now = payer.env.now();
	payer.budget.charge(usd);
	addSpend(payer.env.deps.db, [dayScope(now), monthScope(now), optimScope(payer.optimRunId)], usd, now.toISOString());
	payer.addCost(usd, unknown);
}

/** Runs `fn`, turning a refused budget reservation into a BudgetStop that ends the loop. */
export async function stopOnRefusal<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof NexoError && error.code === "BUDGET_EXCEEDED") throw new BudgetStop("budget_usd", error.message);
		throw error;
	}
}

/** One reflection completion on `models.s2`: a `gepa_call` span (tier `gepa`) charged to the optimization. */
async function reflectionCompletion(payer: OptimPayer, request: { system: string; user: string; purpose: string }): Promise<string> {
	const { env, budget } = payer;
	const { config } = env.deps;
	const spec = config.models.s2;
	const model = env.registry.get(spec.provider, spec.id);
	const effort = env.registry.clampEffort(model, spec.effort ?? "off");
	const { text } = await stopOnRefusal(() =>
		runChargedCompletion(
			{
				env,
				recorder: payer.recorder,
				budget,
				charge: (m, msg) => {
					const priced = priceUsage(m, msg.usage, config.pricingOverrides);
					optimCharge(payer, priced.costUsd, priced.costUnknown);
					return priced;
				},
				refused: (estimate) =>
					new NexoError({
						code: "BUDGET_EXCEEDED",
						message: `The optimization budget cannot cover a reflection call (estimated $${estimate.toFixed(4)}, $${budget.remainingUsd().toFixed(4)} left)`,
					}),
				abortMessage: "The reflection call was aborted",
			},
			{
				model,
				system: request.system,
				user: request.user,
				effort,
				outputTokens: Math.min(REFLECTION_MAX_OUTPUT_TOKENS, config.budgets.estimateOutputTokens),
				span: { kind: "gepa_call", name: `${request.purpose} ${model.id}`, parentSpanId: payer.parentSpanId, tier: "gepa", attrs: { purpose: request.purpose } },
			},
			payer.signal,
		),
	);
	return text;
}

/**
 * Asks the reflection model for a new text of `component` (spec §8.2.2.4). An invalid reply gets one repair request;
 * a second invalid reply, an empty or unchanged text is returned as `{ problem }`. Budget refusals throw BudgetStop.
 */
export async function proposeText(
	payer: OptimPayer,
	input: { target: OptimTarget; component: string; currentText: string; examples: readonly ReflectiveExample[] },
): Promise<{ text: string; rationale: string } | { problem: string }> {
	const system = reflectionSystem(input.target);
	const user = reflectionPrompt(input);
	const first = await reflectionCompletion(payer, { system, user, purpose: "reflect" });
	let checked = validateReply(ProposalSchema, first);
	if (!checked.ok) {
		const second = await reflectionCompletion(payer, { system, user: `${user}\n\n${repairPrompt(first, checked.errors)}`, purpose: "reflect-repair" });
		checked = validateReply(ProposalSchema, second);
		if (!checked.ok) return { problem: `the reflection reply did not match its schema after one repair: ${checked.errors.slice(0, 3).join("; ")}` };
	}
	const problem = proposalProblem(checked.value.text, input.currentText);
	return problem ? { problem } : { text: checked.value.text, rationale: checked.value.rationale };
}
