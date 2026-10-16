import { cosine, jaccard } from "@nexo/memory";
import {
	addSpend,
	dayScope,
	type EvalCaseRow,
	getSpent,
	insertMinedCases,
	listEvalCases,
	type MineItem,
	mineCandidateRuns,
	monthScope,
	normalizeCaseInput,
	type OptimTarget,
	proposeClusters,
	syncRunEvalCases,
} from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import type { EngineEnv } from "../engine/run.ts";
import { checkAdmission } from "../cost/admission.ts";
import { embeddingCost, embeddingEndpoint, embedTexts, estimateEmbeddingUsd } from "../learn/embedder.ts";

export type Embed = (texts: readonly string[]) => Promise<number[][]>;

export interface MineResult {
	/** Cases this pass proposed. */
	added: EvalCaseRow[];
	/** Every proposed case of the target, including `added`. */
	waiting: EvalCaseRow[];
	measure: "cosine" | "jaccard";
	/** Runs considered. */
	considered: number;
	/** The error message when embedding was attempted and failed; null otherwise. */
	fallbackReason: string | null;
}

/** Longest text sent to the embedder; clustering needs only the gist. */
const EMBED_CLIP_CHARS = 2000;
/** Most texts per embedding request. */
const EMBED_CHUNK = 100;

/**
 * Embeds through `models.embedding`, charging the day and month ledgers and `scopes`. Refuses an exhausted ledger
 * (checkAdmission) and throws BUDGET_EXCEEDED when the estimate is more than what is left of the daily or monthly
 * budget. Null without an embedding model.
 */
export function ledgerEmbedder(env: EngineEnv, scopes: readonly string[]): Embed | null {
	const { config, db } = env.deps;
	const endpoint = embeddingEndpoint(config);
	if (!endpoint) return null;
	return async (texts) => {
		const now = env.now();
		checkAdmission(db, config.budgets, now);
		const estimate = estimateEmbeddingUsd(config, endpoint, texts.reduce((n, t) => n + t.length, 0));
		const left = Math.min(config.budgets.dailyUsd - getSpent(db, dayScope(now)), config.budgets.monthlyUsd - getSpent(db, monthScope(now)));
		if (estimate > left) {
			throw new NexoError({ code: "BUDGET_EXCEEDED", message: `Embedding ${texts.length} instructions (estimated $${estimate.toFixed(4)}) is more than the $${Math.max(0, left).toFixed(4)} left today or this month` });
		}
		const result = await embedTexts(endpoint, texts, { apiKey: env.deps.resolveApiKey?.(endpoint.provider) });
		const priced = embeddingCost(config, endpoint, result.tokens);
		addSpend(db, [dayScope(now), monthScope(now), ...scopes], priced.costUsd, now.toISOString());
		return result.vectors;
	};
}

/**
 * One mining pass (design §3): proposes up to `optimize.mine.maxNew` cases from clusters of similar unreviewed runs.
 * Uses embedding cosine when `embed` (default: `ledgerEmbedder` with scope `mine:<target>`) is available and succeeds,
 * otherwise Jaccard. Throws INVALID_REQUEST for judge_rubric.
 */
export async function mineEvalCases(env: EngineEnv, target: OptimTarget, options: { days?: number; embed?: Embed | null } = {}): Promise<MineResult> {
	if (target.kind === "judge_rubric") {
		throw new NexoError({ code: "INVALID_REQUEST", message: "judge_rubric cases come from reviewed runs that the judge scored, not from mining", context: { target: target.key } });
	}
	const { db, config, redact, logger } = env.deps;
	syncRunEvalCases(db, target, env.now().toISOString());
	const settings = config.optimize.mine;
	const now = env.now();
	const days = options.days ?? settings.days;
	const items = mineCandidateRuns(db, target, { sinceIso: new Date(now.getTime() - days * 86_400_000).toISOString(), maxRuns: settings.maxRuns });
	const existing = listEvalCases(db, target.key);
	const waitingOf = () => listEvalCases(db, target.key).filter((c) => c.status === "proposed");
	if (items.length < settings.minCluster) {
		logger.info("mined eval cases", { target: target.key, considered: items.length, measure: "jaccard", added: 0 });
		return { added: [], waiting: waitingOf(), measure: "jaccard", considered: items.length, fallbackReason: null };
	}

	const text = (s: string) => normalizeCaseInput(s);
	let measure: "cosine" | "jaccard" = "jaccard";
	let fallbackReason: string | null = null;
	let similar = (a: MineItem, b: MineItem) => jaccard(text(a.instruction), text(b.instruction)) >= settings.jaccard;
	let nearExisting = (leader: MineItem) => existing.some((c) => jaccard(text(leader.instruction), text(c.input)) >= settings.jaccard);

	const embed = options.embed === undefined ? ledgerEmbedder(env, [`mine:${target.key}`]) : options.embed;
	if (embed) {
		try {
			const texts = [...items.map((i) => text(i.instruction)), ...existing.map((c) => text(c.input))].map((t) => t.slice(0, EMBED_CLIP_CHARS));
			const vectors: number[][] = [];
			for (let at = 0; at < texts.length; at += EMBED_CHUNK) vectors.push(...(await embed(texts.slice(at, at + EMBED_CHUNK))));
			if (vectors.length !== texts.length) throw new Error(`embedder returned ${vectors.length} vectors for ${texts.length} texts`);
			const byRun = new Map(items.map((i, k) => [i.runId, vectors[k] as number[]]));
			const caseVectors = existing.map((_, k) => vectors[items.length + k] as number[]);
			similar = (a, b) => cosine(byRun.get(a.runId) as number[], byRun.get(b.runId) as number[]) >= settings.cosine;
			nearExisting = (leader) => caseVectors.some((v) => cosine(byRun.get(leader.runId) as number[], v) >= settings.cosine);
			measure = "cosine";
		} catch (error) {
			fallbackReason = error instanceof Error ? error.message : String(error);
			logger.warn("embedding mined instructions failed; clustering by word overlap instead", { target: target.key, error });
		}
	}

	const clusters = proposeClusters(items, { similar, nearExisting, minCluster: settings.minCluster, maxNew: settings.maxNew });
	const added = insertMinedCases(db, target, clusters, redact, now.toISOString());
	logger.info("mined eval cases", { target: target.key, considered: items.length, measure, added: added.length });
	return { added, waiting: waitingOf(), measure, considered: items.length, fallbackReason };
}

/** Mining before an optimization or climb: never fails it, only logs. */
export async function mineQuietly(env: EngineEnv, target: OptimTarget): Promise<void> {
	if (target.kind === "judge_rubric") return;
	try {
		await mineEvalCases(env, target);
	} catch (error) {
		env.deps.logger.warn("mining eval cases failed; continuing without it", { target: target.key, error });
	}
}
