import type { Redactor } from "@nexo/telemetry";
import { type Db, transaction } from "./db.ts";
import { caseSplit, MAX_EVAL_INPUT_CHARS, type OptimTarget, targetRunFilter } from "./eval-cases.ts";
import { newId } from "./ids.ts";
import { type EvalCaseRow, getEvalCase } from "./judge-calibration.ts";

/** One unreviewed run considered by mining. */
export interface MineItem {
	runId: string;
	instruction: string;
	skill: string | null;
	startedAt: string;
}

/**
 * Runs mining may turn into proposed cases (design §3.2): root runs of `target` (see `targetRunFilter`) with no
 * feedback, not already the source of a case for `target`, started at or after `sinceIso`; the newest `maxRuns`, newest first.
 */
export function mineCandidateRuns(db: Db, target: OptimTarget, options: { sinceIso: string; maxRuns: number }): MineItem[] {
	const filter = targetRunFilter(target);
	return db
		.prepare(
			`SELECT r.id, r.instruction, r.skill, r.started_at FROM runs r WHERE ${filter.sql}
			AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.run_id = r.id)
			AND NOT EXISTS (SELECT 1 FROM eval_cases c WHERE c.target = ? AND c.source_run_id = r.id)
			AND r.started_at >= ?
			ORDER BY r.started_at DESC, r.id DESC LIMIT ?`,
		)
		.all(...filter.args, target.key, options.sinceIso, options.maxRuns)
		.map((row) => ({ runId: String(row.id), instruction: String(row.instruction), skill: (row.skill as string | null) ?? null, startedAt: String(row.started_at) }));
}

/**
 * Greedy leader clustering (design §3.3). `items` are newest first; each joins the first cluster whose leader (first
 * member) it is `similar` to, or leads a new one. Clusters smaller than `minCluster`, and clusters whose leader is
 * `nearExisting`, are dropped; the rest are ordered by size, then by leader position, and capped at `maxNew`.
 */
export function proposeClusters<T>(items: readonly T[], options: { similar: (a: T, b: T) => boolean; nearExisting: (leader: T) => boolean; minCluster: number; maxNew: number }): T[][] {
	const clusters: T[][] = [];
	for (const item of items) {
		const home = clusters.find((c) => options.similar(c[0] as T, item));
		if (home) home.push(item);
		else clusters.push([item]);
	}
	return clusters
		.map((members, order) => ({ members, order }))
		.filter((c) => c.members.length >= options.minCluster && !options.nearExisting(c.members[0] as T))
		.sort((a, b) => b.members.length - a.members.length || a.order - b.order)
		.slice(0, options.maxNew)
		.map((c) => c.members);
}

/** Stores one proposed case per cluster, led by its newest run (design §3.3), in one transaction. */
export function insertMinedCases(db: Db, target: OptimTarget, clusters: readonly MineItem[][], redact: Redactor, nowIso: string): EvalCaseRow[] {
	return transaction(db, () =>
		clusters.map((members) => {
			const leader = members[0] as MineItem;
			const text = redact(leader.instruction.trim());
			const input = text.length > MAX_EVAL_INPUT_CHARS ? `${text.slice(0, MAX_EVAL_INPUT_CHARS - 1)}…` : text;
			const id = newId();
			db.prepare(
				"INSERT INTO eval_cases (id, target, source_run_id, input, expected, reference_feedback, scorer_spec_json, split, created_at, skill, origin, status, golden_source, mined_from_json) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, 'mined', 'proposed', NULL, ?)",
			).run(id, target.key, leader.runId, input, caseSplit(input), nowIso, target.kind === "skill" ? target.name : leader.skill, JSON.stringify(members.map((m) => m.runId)));
			return getEvalCase(db, id) as EvalCaseRow;
		}),
	);
}
