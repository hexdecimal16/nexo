import type { CaseScore } from "@nexo/store";
import { pickWeighted, type Rng } from "./rng.ts";

/** Pareto-split results: candidate id → eval case id → score. Every candidate in it was evaluated on every case. */
export type ScoreTable = Map<string, Record<string, CaseScore>>;

const MISSING: CaseScore = { quality: 0, costUsd: Number.POSITIVE_INFINITY };

function scoreOf(table: ScoreTable, id: string, caseId: string): CaseScore {
	return table.get(id)?.[caseId] ?? MISSING;
}

/** `a` dominates `b` on one case: quality at least as high and cost at most as high, one of them strictly. */
export function caseDominates(a: CaseScore, b: CaseScore): boolean {
	return a.quality >= b.quality && a.costUsd <= b.costUsd && (a.quality > b.quality || a.costUsd < b.costUsd);
}

/** Per candidate, the number of cases on which no other candidate dominates it (per-case quality and cost fronts). */
export function winCounts(table: ScoreTable, caseIds: readonly string[]): Map<string, number> {
	const ids = [...table.keys()];
	const wins = new Map(ids.map((id) => [id, 0]));
	for (const caseId of caseIds) {
		for (const id of ids) {
			const mine = scoreOf(table, id, caseId);
			if (!ids.some((other) => other !== id && caseDominates(scoreOf(table, other, caseId), mine))) wins.set(id, (wins.get(id) ?? 0) + 1);
		}
	}
	return wins;
}

/** `b` dominates `a` across all cases: at least as good on every case (quality ≥, cost ≤) and strictly better on one. */
export function dominatedEverywhere(table: ScoreTable, a: string, b: string, caseIds: readonly string[]): boolean {
	let strict = false;
	for (const caseId of caseIds) {
		const sa = scoreOf(table, a, caseId);
		const sb = scoreOf(table, b, caseId);
		if (sb.quality < sa.quality || sb.costUsd > sa.costUsd) return false;
		if (sb.quality > sa.quality || sb.costUsd < sa.costUsd) strict = true;
	}
	return strict;
}

/**
 * The Pareto members: candidates that win at least one case and that no other candidate dominates across all cases,
 * with their win counts, in table order.
 */
export function paretoMembers(table: ScoreTable, caseIds: readonly string[]): { id: string; wins: number }[] {
	const wins = winCounts(table, caseIds);
	const ids = [...table.keys()];
	return ids
		.filter((id) => (wins.get(id) ?? 0) > 0 && !ids.some((other) => other !== id && dominatedEverywhere(table, id, other, caseIds)))
		.map((id) => ({ id, wins: wins.get(id) ?? 0 }));
}

/** Pareto sampling (spec §8.2.2.1): a member, picked in proportion to its win count. */
export function selectCandidate(table: ScoreTable, caseIds: readonly string[], rng: Rng, offspring?: ReadonlyMap<string, number>, alpha = OFFSPRING_ALPHA): string {
	const members = paretoMembers(table, caseIds);
	if (members.length === 0) throw new RangeError("selectCandidate needs at least one evaluated candidate");
	return pickWeighted(
		members.map((m) => m.id),
		members.map((m) => m.wins / (1 + alpha * (offspring?.get(m.id) ?? 0))),
		rng,
	);
}

/** Mean quality and mean cost over `caseIds` (0 and 0 for no cases). */
export function meanOf(scores: Record<string, CaseScore>, caseIds: readonly string[]): CaseScore {
	if (caseIds.length === 0) return { quality: 0, costUsd: 0 };
	let quality = 0;
	let costUsd = 0;
	for (const id of caseIds) {
		const s = scores[id] ?? MISSING;
		quality += s.quality;
		costUsd += s.costUsd;
	}
	return { quality: quality / caseIds.length, costUsd: costUsd / caseIds.length };
}

/** The best candidate: highest mean quality, then lowest mean cost, then the earliest in table order. */
export function bestCandidate(table: ScoreTable, caseIds: readonly string[]): string {
	let best: { id: string; mean: CaseScore } | null = null;
	for (const [id, scores] of table) {
		const mean = meanOf(scores, caseIds);
		if (!best || mean.quality > best.mean.quality || (mean.quality === best.mean.quality && mean.costUsd < best.mean.costUsd)) best = { id, mean };
	}
	if (!best) throw new RangeError("bestCandidate needs at least one evaluated candidate");
	return best.id;
}

/**
 * Darwin Godel Machine parent weighting: a member's win count is divided by 1 + OFFSPRING_ALPHA * children, so a
 * parent that already has many children is sampled less and the other Pareto branches get explored.
 */
export const OFFSPRING_ALPHA = 0.5;
