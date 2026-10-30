import { fauxAssistantMessage, type FauxResponseFactory, getSystemMessageText, type TranscriptContext } from "@earendil-works/pi-ai";
import type { EvalCase } from "@nexo/optimize";
import { type ArtifactRow, ensureManualArtifact, type OptimTarget, parseOptimTarget } from "@nexo/store";
import { join } from "node:path";
import { createEngineEnv, type DeepPartial, type EngineEnv, type NexoConfig, RunBudget } from "../src/index.ts";
import type { OptimContext } from "../src/optimize/adapter.ts";
import { openOptimizerRun } from "../src/optimize/optimizer-run.ts";
import { firstUserText, makeEnv, type TestEnv } from "./helpers.ts";
import { JUDGE, JUDGE_MODELS } from "./scoring-helpers.ts";

export const SKILL_HEAD = "---\nname: ci-fix\ndescription: Fix CI\n---\n";
export const SKILL = `${SKILL_HEAD}Run the linter.\n`;

/** makeEnv with the ci-fix skill, a judge, and these config overrides. */
export function optimEnv(config: DeepPartial<NexoConfig> = {}): TestEnv {
	return makeEnv({ skills: { "ci-fix": SKILL }, config: { ...JUDGE, ...config, optimize: { reflectionTier: "s2", ...(config.optimize ?? {}) } }, extraModels: JUDGE_MODELS });
}

export interface CallContext {
	system: string;
	user: string;
	context: TranscriptContext;
	/** The id of the model the call went to. */
	model: string;
}

/**
 * Routes every model call by role: the judge models (`*-judge`), the reflection model (`slow`, models.s2) and the agent
 * (`fast`). Each handler returns the reply text; the calls of each role are recorded.
 */
export function route(env: TestEnv, handlers: { agent?: (c: CallContext) => string; judge?: (c: CallContext) => string; reflect?: (c: CallContext) => string }): Record<"agent" | "judge" | "reflect", CallContext[]> {
	const calls: Record<"agent" | "judge" | "reflect", CallContext[]> = { agent: [], judge: [], reflect: [] };
	const factory: FauxResponseFactory = async (context, _opts, _state, model) => {
		const role = model.id.endsWith("-judge") ? "judge" : model.id === "slow" ? "reflect" : "agent";
		const call: CallContext = { system: context.messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n"), user: firstUserText(context), context, model: model.id };
		calls[role].push(call);
		const handler = handlers[role];
		if (!handler) throw new Error(`no ${role} handler`);
		return fauxAssistantMessage(handler(call));
	};
	env.faux.setResponses(Array.from({ length: 400 }, () => factory));
	return calls;
}

export function evalCase(id: string, input: string, overrides: Partial<EvalCase> = {}): EvalCase {
	return { id, input, skill: null, expected: null, referenceFeedback: null, sourceRunId: null, ...overrides };
}

/** An OptimContext on a fresh optimizer run for `target`, with a $budgetUsd optimization budget. */
export function optimContext(env: TestEnv, target: OptimTarget | string, options: { budgetUsd?: number; rolloutsLeft?: number; optimRunId?: string } = {}): { ctx: OptimContext; engineEnv: EngineEnv; base: ArtifactRow } {
	const engineEnv = createEngineEnv(env.deps);
	const t = typeof target === "string" ? parseOptimTarget(target) : target;
	const optimRunId = options.optimRunId ?? `01OPT${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6)}`;
	const optimizer = openOptimizerRun(engineEnv, optimRunId, t);
	const nowIso = new Date().toISOString();
	const base =
		t.kind === "skill"
			? ensureManualArtifact(env.deps.db, "skill", t.name, SKILL, nowIso)
			: t.kind === "judge_rubric"
				? ensureManualArtifact(env.deps.db, "judge_rubric", "default", "Grade the work.", nowIso)
				: ensureManualArtifact(env.deps.db, t.kind, "default", "Be precise in {{workspace}}.", nowIso);
	let costUsd = 0;
	const ctx: OptimContext = {
		env: engineEnv,
		optimRunId,
		recorder: optimizer.recorder,
		parentSpanId: optimizer.spanId,
		budget: new RunBudget(options.budgetUsd ?? 5),
		signal: new AbortController().signal,
		addCost: (usd) => {
			costUsd += usd;
		},
		target: t,
		runsRoot: join(optimizer.runDir.root, "rollouts"),
		phase: "setup",
		reserveUsd: 0,
		rolloutsLeft: options.rolloutsLeft ?? Number.POSITIVE_INFINITY,
		rollouts: 0,
	};
	return { ctx, engineEnv, base };
}
