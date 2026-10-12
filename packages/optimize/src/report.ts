import type { CaseScore, OptimCandidateRow, OptimStopReason } from "@nexo/store";
import { meanOf } from "./pareto.ts";

export interface DiffLine {
	op: "same" | "add" | "del";
	text: string;
}

/** Largest line-count product compared with LCS; bigger texts diff as a whole replacement. */
export const MAX_DIFF_CELLS = 4_000_000;

/** A line diff from `a` to `b` (longest common subsequence of lines). */
export function lineDiff(a: string, b: string): DiffLine[] {
	const x = a.split("\n");
	const y = b.split("\n");
	if (x.length * y.length > MAX_DIFF_CELLS) {
		return [...x.map((text) => ({ op: "del" as const, text })), ...y.map((text) => ({ op: "add" as const, text }))];
	}
	const n = x.length;
	const m = y.length;
	const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (x[i] === y[j]) {
			out.push({ op: "same", text: x[i] as string });
			i++;
			j++;
		} else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
			out.push({ op: "del", text: x[i++] as string });
		} else {
			out.push({ op: "add", text: y[j++] as string });
		}
	}
	while (i < n) out.push({ op: "del", text: x[i++] as string });
	while (j < m) out.push({ op: "add", text: y[j++] as string });
	return out;
}

export type CaseOutcome = "win" | "loss" | "tie";

const EPS = 1e-9;

/** The best candidate against the base on one case: quality decides, then cost. */
export function caseOutcome(before: CaseScore, after: CaseScore): CaseOutcome {
	if (after.quality > before.quality + EPS) return "win";
	if (after.quality < before.quality - EPS) return "loss";
	if (after.costUsd < before.costUsd - EPS) return "win";
	if (after.costUsd > before.costUsd + EPS) return "loss";
	return "tie";
}

export interface ReportCase {
	caseId: string;
	/** First 200 characters of the case input. */
	input: string;
	before: CaseScore;
	after: CaseScore;
	outcome: CaseOutcome;
}

export interface LineageEntry {
	candidateId: string;
	artifactId: string;
	parentIds: string[];
	iteration: number;
	origin: OptimCandidateRow["origin"];
	component: string | null;
	accepted: boolean;
	meanScore: number | null;
	meanCostUsd: number | null;
	/** Mean minibatch quality of the parent and of this candidate; null for the seed and merges. */
	minibatch: { parent: number; child: number } | null;
}

export interface ReportEvidence {
	/** True when every quality-bearing holdout score came from the LLM judge. */
	judgeOnly: boolean;
	/** True for judge_rubric, whose candidates are scored by human verdicts only. */
	humanScored: boolean;
	judgeKey: string | null;
	/** The judge's live Cohen's κ against human verdicts when the report was written. */
	kappa: number | null;
	minJudgeKappa: number;
}

export interface OptimReport {
	optimRunId: string;
	target: string;
	baseArtifactId: string;
	bestArtifactId: string;
	/** False when no candidate beat the base on the pareto split (nothing to promote). */
	improved: boolean;
	holdout: { cases: ReportCase[]; before: CaseScore; after: CaseScore; wins: number; losses: number; ties: number };
	diff: DiffLine[];
	lineage: LineageEntry[];
	evidence: ReportEvidence;
	stopReason: OptimStopReason;
	spentUsd: number;
	rollouts: number;
	iterations: number;
	merges: number;
	/** Why merging did nothing, when `--merge` was given and no merge happened. */
	mergeNote: string | null;
	createdAt: string;
}

export interface ReportInput {
	optimRunId: string;
	target: string;
	baseArtifactId: string;
	bestArtifactId: string;
	baseText: string;
	bestText: string;
	holdout: { caseId: string; input: string }[];
	before: Record<string, CaseScore>;
	after: Record<string, CaseScore>;
	candidates: readonly OptimCandidateRow[];
	evidence: ReportEvidence;
	stopReason: OptimStopReason;
	spentUsd: number;
	rollouts: number;
	iterations: number;
	merges: number;
	mergeNote: string | null;
	createdAt: string;
}

const mean = (xs: readonly CaseScore[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x.quality, 0) / xs.length);

/** The holdout report (spec §8.2.5). */
export function buildReport(input: ReportInput): OptimReport {
	const ids = input.holdout.map((h) => h.caseId);
	const cases: ReportCase[] = input.holdout.map((h) => {
		const before = input.before[h.caseId] ?? { quality: 0, costUsd: 0 };
		const after = input.after[h.caseId] ?? { quality: 0, costUsd: 0 };
		return { caseId: h.caseId, input: h.input.slice(0, 200), before, after, outcome: caseOutcome(before, after) };
	});
	return {
		optimRunId: input.optimRunId,
		target: input.target,
		baseArtifactId: input.baseArtifactId,
		bestArtifactId: input.bestArtifactId,
		improved: input.bestArtifactId !== input.baseArtifactId,
		holdout: {
			cases,
			before: meanOf(input.before, ids),
			after: meanOf(input.after, ids),
			wins: cases.filter((c) => c.outcome === "win").length,
			losses: cases.filter((c) => c.outcome === "loss").length,
			ties: cases.filter((c) => c.outcome === "tie").length,
		},
		diff: lineDiff(input.baseText, input.bestText),
		lineage: input.candidates.map((c) => ({
			candidateId: c.id,
			artifactId: c.artifactId,
			parentIds: c.parentIds,
			iteration: c.iteration,
			origin: c.origin,
			component: c.component,
			accepted: c.accepted,
			meanScore: c.meanScore,
			meanCostUsd: c.meanCostUsd,
			minibatch: c.minibatch ? { parent: mean(c.minibatch.parent), child: mean(c.minibatch.child) } : null,
		})),
		evidence: input.evidence,
		stopReason: input.stopReason,
		spentUsd: input.spentUsd,
		rollouts: input.rollouts,
		iterations: input.iterations,
		merges: input.merges,
		mergeNote: input.mergeNote,
		createdAt: input.createdAt,
	};
}
