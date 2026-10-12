import type { CaseScore, MinibatchRecord, OptimStopReason } from "@nexo/store";
import { findMerge, type LineageNode } from "./merge.ts";
import { bestCandidate, meanOf, paretoMembers, type ScoreTable, selectCandidate } from "./pareto.ts";
import type { ReflectiveExample } from "./proposer.ts";
import { type Rng, sampleWithoutReplacement } from "./rng.ts";
import type { ComponentTexts } from "./target.ts";

/** Feedback cases per minibatch (spec §8.2.2.3). */
export const MINIBATCH_SIZE = 3;
/** Most system-aware merges per optimization (spec §8.2.2.6). */
export const MAX_MERGES = 5;

/** One eval case as the optimizer sees it. */
export interface EvalCase {
	id: string;
	input: string;
	skill: string | null;
	expected: string | null;
	referenceFeedback: string | null;
	sourceRunId: string | null;
}

/** A candidate the adapter can evaluate: its candidate id, its artifact version and its texts. */
export interface CandidateRef {
	id: string;
	artifactId: string;
	texts: ComponentTexts;
}

/** Scores of one candidate on a batch (aligned with the batch), with traces when they were asked for. */
export interface EvaluationBatch {
	scores: CaseScore[];
	traces: ReflectiveExample[] | null;
}

/** Thrown by an adapter or a callback when the optimization's budget cannot pay for the next rollout or call. */
export class BudgetStop extends Error {
	readonly reason: "budget_usd" | "budget_rollouts";

	constructor(reason: "budget_usd" | "budget_rollouts", message: string) {
		super(message);
		this.name = "BudgetStop";
		this.reason = reason;
	}
}

/** gepa's adapter (spec §8.2.8): run candidates on cases, turn traces into reflection examples, propose new texts. */
export interface GepaAdapter {
	evaluate(batch: readonly EvalCase[], candidate: CandidateRef, captureTraces: boolean, signal: AbortSignal): Promise<EvaluationBatch>;
	makeReflectiveDataset(candidate: CandidateRef, evalBatch: EvaluationBatch, components: readonly string[]): Record<string, ReflectiveExample[]>;
	/** New texts for `components`, or null when the reflection produced no usable text. */
	proposeNewTexts?(candidate: CandidateRef, dataset: Record<string, ReflectiveExample[]>, components: readonly string[], signal: AbortSignal): Promise<ComponentTexts | null>;
}

export type GepaEvent =
	| { type: "iteration"; iteration: number; parentId: string; component: string }
	| { type: "rejected"; iteration: number; reason: string }
	| { type: "minibatch"; iteration: number; candidateId: string; parentQuality: number; childQuality: number; accepted: boolean }
	| { type: "pareto"; candidateId: string; meanQuality: number; meanCostUsd: number; newMember: boolean }
	| { type: "merge"; candidateId: string; parents: [string, string]; accepted: boolean };

/** Persistence and budget hooks of the loop; `startOptimization` implements them with the store. */
export interface GepaCallbacks {
	/** Stores a new candidate (its artifact version and candidate row) and returns it. */
	createCandidate(input: { parentIds: string[]; texts: ComponentTexts; iteration: number; origin: "reflect" | "merge"; component: string | null }): CandidateRef;
	/** Records a child's minibatch comparison with its parent and whether it was accepted. */
	recordMinibatch(candidateId: string, record: MinibatchRecord, accepted: boolean): void;
	/** Records a candidate's pareto-split results and whether it joined the candidate pool. */
	recordPareto(candidateId: string, perCase: Record<string, CaseScore>, accepted: boolean): void;
	/** Why no further iteration can start (a budget), or null when one can. */
	canStartIteration(): OptimStopReason | null;
	onEvent?(event: GepaEvent): void;
}

export interface GepaOptions {
	adapter: GepaAdapter;
	callbacks: GepaCallbacks;
	/** The base version and its pareto-split results (evaluated by the caller). */
	seed: CandidateRef;
	seedPareto: Record<string, CaseScore>;
	components: readonly string[];
	feedback: readonly EvalCase[];
	pareto: readonly EvalCase[];
	patience: number;
	merge: boolean;
	rng: Rng;
	signal: AbortSignal;
}

export interface GepaResult {
	/** Pareto-split results of every candidate in the pool (the seed and accepted children and merges). */
	table: ScoreTable;
	bestId: string;
	stopReason: OptimStopReason;
	iterations: number;
	merges: number;
}

const EPS = 1e-9;

function sameTexts(a: ComponentTexts, b: ComponentTexts): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].every((k) => a[k] === b[k]);
}

function meanQuality(scores: readonly CaseScore[]): number {
	return scores.length === 0 ? 0 : scores.reduce((sum, s) => sum + s.quality, 0) / scores.length;
}

/**
 * The GEPA loop (spec §8.2.2): Pareto-sample a parent, take the next component round-robin, roll it out on a minibatch
 * with traces, reflect a new text, keep the child only if its minibatch quality improves, then evaluate it on the
 * pareto split. Stops on a budget (`canStartIteration` or a BudgetStop), after `patience` iterations without a new
 * Pareto member, or on abort; any other error propagates.
 */
export async function runGepa(options: GepaOptions): Promise<GepaResult> {
	const { adapter, callbacks, rng, signal } = options;
	const propose = adapter.proposeNewTexts?.bind(adapter);
	if (!propose) throw new TypeError("runGepa needs an adapter with proposeNewTexts");
	const caseIds = options.pareto.map((c) => c.id);
	const table: ScoreTable = new Map([[options.seed.id, options.seedPareto]]);
	const refs = new Map<string, CandidateRef>([[options.seed.id, options.seed]]);
	const nodes = new Map<string, LineageNode>([[options.seed.id, { id: options.seed.id, parentIds: [] }]]);
	const texts = new Map<string, ComponentTexts>([[options.seed.id, options.seed.texts]]);
	const tried = new Set<string>();
	const memberIds = () => new Set(paretoMembers(table, caseIds).map((m) => m.id));
	const emit = (event: GepaEvent) => callbacks.onEvent?.(event);
	let iterations = 0;
	let stale = 0;
	let merges = 0;
	let componentIndex = 0;
	let stopReason: OptimStopReason | null = null;

	const remember = (ref: CandidateRef, parentIds: string[]) => {
		refs.set(ref.id, ref);
		nodes.set(ref.id, { id: ref.id, parentIds });
		texts.set(ref.id, ref.texts);
	};
	const evaluate = async (batch: readonly EvalCase[], ref: CandidateRef, captureTraces: boolean): Promise<EvaluationBatch> => {
		const result = await adapter.evaluate(batch, ref, captureTraces, signal);
		if (result.scores.length !== batch.length) throw new Error(`the adapter returned ${result.scores.length} scores for ${batch.length} cases`);
		return result;
	};
	const evaluatePareto = async (ref: CandidateRef): Promise<Record<string, CaseScore>> => {
		const result = await evaluate(options.pareto, ref, false);
		return Object.fromEntries(options.pareto.map((c, i) => [c.id, result.scores[i] as CaseScore]));
	};

	try {
		for (;;) {
			if (signal.aborted) {
				stopReason = "aborted";
				break;
			}
			if (stale >= options.patience) {
				stopReason = "patience";
				break;
			}
			const blocked = callbacks.canStartIteration();
			if (blocked) {
				stopReason = blocked;
				break;
			}
			iterations++;
			const parentId = selectCandidate(table, caseIds, rng);
			const parent = refs.get(parentId) as CandidateRef;
			const component = options.components[componentIndex++ % options.components.length] as string;
			emit({ type: "iteration", iteration: iterations, parentId, component });
			const batch = sampleWithoutReplacement(options.feedback, MINIBATCH_SIZE, rng);
			const parentEval = await evaluate(batch, parent, true);
			const dataset = adapter.makeReflectiveDataset(parent, parentEval, [component]);
			const proposed = await propose(parent, dataset, [component], signal);
			if (!proposed) {
				stale++;
				emit({ type: "rejected", iteration: iterations, reason: "the reflection produced no usable text" });
				continue;
			}
			const childTexts = { ...parent.texts, ...proposed };
			if ([...texts.values()].some((known) => sameTexts(known, childTexts))) {
				stale++;
				emit({ type: "rejected", iteration: iterations, reason: "the proposed text is already a candidate" });
				continue;
			}
			const child = callbacks.createCandidate({ parentIds: [parentId], texts: childTexts, iteration: iterations, origin: "reflect", component });
			remember(child, [parentId]);
			const childEval = await evaluate(batch, child, false);
			const parentQuality = meanQuality(parentEval.scores);
			const childQuality = meanQuality(childEval.scores);
			const accepted = childQuality > parentQuality + EPS;
			callbacks.recordMinibatch(child.id, { caseIds: batch.map((c) => c.id), parent: parentEval.scores, child: childEval.scores }, accepted);
			emit({ type: "minibatch", iteration: iterations, candidateId: child.id, parentQuality, childQuality, accepted });
			if (!accepted) {
				stale++;
				continue;
			}
			const before = memberIds();
			const perCase = await evaluatePareto(child);
			table.set(child.id, perCase);
			callbacks.recordPareto(child.id, perCase, true);
			const after = memberIds();
			const newMember = after.has(child.id) && !before.has(child.id);
			stale = newMember ? 0 : stale + 1;
			const mean = meanOf(perCase, caseIds);
			emit({ type: "pareto", candidateId: child.id, meanQuality: mean.quality, meanCostUsd: mean.costUsd, newMember });
			if (!options.merge || merges >= MAX_MERGES) continue;
			const plan = findMerge([...after], nodes, texts, tried);
			if (!plan) continue;
			tried.add(`${plan.a}|${plan.b}`);
			const merged = callbacks.createCandidate({ parentIds: [plan.a, plan.b], texts: plan.texts, iteration: iterations, origin: "merge", component: null });
			remember(merged, [plan.a, plan.b]);
			merges++;
			const mergedCases = await evaluatePareto(merged);
			table.set(merged.id, mergedCases);
			const kept = memberIds().has(merged.id);
			if (!kept) table.delete(merged.id);
			callbacks.recordPareto(merged.id, mergedCases, kept);
			emit({ type: "merge", candidateId: merged.id, parents: [plan.a, plan.b], accepted: kept });
		}
	} catch (error) {
		if (error instanceof BudgetStop) stopReason = error.reason;
		else if (signal.aborted) stopReason = "aborted";
		else throw error;
	}
	return { table, bestId: bestCandidate(table, caseIds), stopReason: stopReason ?? "patience", iterations, merges };
}
