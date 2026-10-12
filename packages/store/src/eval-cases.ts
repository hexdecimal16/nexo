import type { SQLInputValue } from "node:sqlite";
import type { Redactor } from "@nexo/telemetry";
import { type Db, transaction } from "./db.ts";
import { invalidRequest } from "./errors.ts";
import { latestFeedback } from "./feedback.ts";
import { newId } from "./ids.ts";
import { type EvalCaseRow, type EvalSplit, evalSplitFor, listEvalCases } from "./judge-calibration.ts";
import { readRunJson } from "./run-dir.ts";
import { getRun } from "./runs.ts";

/** Longest eval-case input, expected text or reference feedback, in characters. */
export const MAX_EVAL_INPUT_CHARS = 20_000;

/** Most runs listed when an eval set is too small or a promotion needs more human verdicts. */
export const RUNS_TO_REVIEW = 10;

export type OptimTargetKind = "skill" | "system_prompt" | "planner_prompt" | "judge_rubric";

/** What an optimization changes: one artifact (kind and name), written as `key` (`skill:<name>`, `system_prompt`, …). */
export interface OptimTarget {
	key: string;
	kind: OptimTargetKind;
	/** The skill name for `skill:<name>`, else "default" (the artifact name of the prompts and the rubric). */
	name: string;
}

const SKILL_TARGET = /^skill:([a-z0-9]+(-[a-z0-9]+)*)$/;

/**
 * Parses an optimization target. `router_policy` is refused: it is a JSON policy of numeric thresholds, not prose.
 * Throws INVALID_REQUEST.
 */
export function parseOptimTarget(text: string): OptimTarget {
	const skill = SKILL_TARGET.exec(text);
	if (skill && (skill[1] as string).length <= 64) return { key: text, kind: "skill", name: skill[1] as string };
	if (text === "system_prompt" || text === "planner_prompt" || text === "judge_rubric") return { key: text, kind: text, name: "default" };
	if (text === "router_policy") {
		throw invalidRequest(
			"router_policy is not an optimization target yet: it is a JSON policy of numeric thresholds, not prose, and evaluating one needs S2 escalation rollouts on every case",
			{ target: text },
			"Optimize skill:<name>, system_prompt, planner_prompt or judge_rubric; edit router thresholds with router.policy = file:<path>",
		);
	}
	throw invalidRequest(`Unknown optimization target "${text}"`, { target: text }, "Use skill:<name>, system_prompt, planner_prompt or judge_rubric");
}

/** The text a case's split is derived from: trimmed, whitespace collapsed, lower-cased. */
export function normalizeCaseInput(input: string): string {
	return input.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The split of a case: a stable hash of its normalized input, so the same instruction always lands in the same split. */
export function caseSplit(input: string): EvalSplit {
	return evalSplitFor(normalizeCaseInput(input));
}

/** Root runs that can be eval cases of `target`: finished, not optimization runs, not a session turn after the first. */
function targetRunFilter(target: OptimTarget): { sql: string; args: SQLInputValue[] } {
	const base = "r.parent_run_id IS NULL AND r.optim_run_id IS NULL AND r.status != 'running' AND (r.session_id IS NULL OR r.turn_index = 1)";
	if (target.kind === "skill") {
		return {
			sql: `${base} AND (r.skill = ? OR EXISTS (SELECT 1 FROM spans s WHERE s.run_id = r.id AND s.kind = 'skill_load' AND s.status = 'ok' AND json_extract(s.attrs_json, '$.args.name') = ?))`,
			args: [target.name, target.name],
		};
	}
	if (target.kind === "judge_rubric") {
		return { sql: `${base} AND EXISTS (SELECT 1 FROM scores s WHERE s.run_id = r.id AND s.scorer_type = 'llm_judge' AND s.status = 'ok')`, args: [] };
	}
	return { sql: base, args: [] };
}

function clip(text: string): string {
	return text.length > MAX_EVAL_INPUT_CHARS ? `${text.slice(0, MAX_EVAL_INPUT_CHARS - 1)}…` : text;
}

/**
 * Turns every reviewed run of `target` into an eval case (one per run), refreshing cases whose verdict changed, and
 * recomputes every case's split from its input. Agent targets: `expected` is the run's output when the verdict is
 * done, `reference_feedback` the comment. `judge_rubric`: `expected` is the verdict.
 */
export function syncRunEvalCases(db: Db, target: OptimTarget, nowIso: string): { added: number; updated: number } {
	const filter = targetRunFilter(target);
	const ids = db
		.prepare(`SELECT r.id FROM runs r WHERE ${filter.sql} AND EXISTS (SELECT 1 FROM feedback f WHERE f.run_id = r.id) ORDER BY r.started_at, r.id`)
		.all(...filter.args)
		.map((row) => String(row.id));
	let added = 0;
	let updated = 0;
	transaction(db, () => {
		for (const id of ids) {
			const run = getRun(db, id);
			const feedback = latestFeedback(db, id);
			if (!run || !feedback) continue;
			let expected: string | null;
			if (target.kind === "judge_rubric") {
				expected = feedback.verdict;
			} else {
				let output = "";
				try {
					output = readRunJson(run.dirPath).output ?? "";
				} catch {
					output = "";
				}
				expected = feedback.verdict === "done" && output.trim() ? clip(output) : null;
			}
			const reference = feedback.comment.trim() ? clip(feedback.comment) : null;
			const existing = db.prepare("SELECT id FROM eval_cases WHERE target = ? AND source_run_id = ?").get(target.key, id);
			if (existing) {
				db.prepare("UPDATE eval_cases SET expected = ?, reference_feedback = ?, skill = ? WHERE id = ?").run(expected, reference, run.skill, String(existing.id));
				updated++;
			} else {
				db.prepare(
					"INSERT INTO eval_cases (id, target, source_run_id, input, expected, reference_feedback, scorer_spec_json, split, created_at, skill, origin) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'run')",
				).run(newId(), target.key, id, run.instruction, expected, reference, caseSplit(run.instruction), nowIso, run.skill);
				added++;
			}
		}
		const update = db.prepare("UPDATE eval_cases SET split = ? WHERE id = ? AND split != ?");
		for (const c of listEvalCases(db, target.key)) {
			const split = caseSplit(c.input);
			update.run(split, c.id, split);
		}
	});
	return { added, updated };
}

export interface NewEvalCase {
	target: string;
	input: string;
	skill?: string | null;
	expected?: string | null;
	referenceFeedback?: string | null;
}

/** Stores a hand-written eval case (`origin = 'manual'`), redacted. Throws INVALID_REQUEST. */
export function addEvalCase(db: Db, input: NewEvalCase, redact: Redactor, nowIso: string): EvalCaseRow {
	const target = parseOptimTarget(input.target);
	if (target.kind === "judge_rubric") {
		throw invalidRequest("judge_rubric cases come from reviewed runs that the judge scored", { target: target.key }, "Review judged runs in the UI or with /done and /notdone; they become judge_rubric cases");
	}
	const text = input.input.trim();
	if (!text) throw invalidRequest("The case input is empty");
	const check = (name: string, value: string | null | undefined) => {
		if (value && value.length > MAX_EVAL_INPUT_CHARS) throw invalidRequest(`${name} is longer than ${MAX_EVAL_INPUT_CHARS} characters`, { length: value.length });
	};
	check("input", text);
	check("expected", input.expected);
	check("feedback", input.referenceFeedback);
	const skill = target.kind === "skill" ? target.name : (input.skill ?? null);
	if (target.kind === "skill" && input.skill && input.skill !== target.name) {
		throw invalidRequest(`A ${target.key} case always runs with skill ${target.name}`, { skill: input.skill });
	}
	if (skill !== null && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill)) throw invalidRequest("skill must be a skill name", { skill });
	const row: EvalCaseRow = {
		id: newId(),
		target: target.key,
		sourceRunId: null,
		input: redact(text),
		expected: input.expected?.trim() ? redact(input.expected.trim()) : null,
		referenceFeedback: input.referenceFeedback?.trim() ? redact(input.referenceFeedback.trim()) : null,
		scorerSpec: null,
		split: caseSplit(redact(text)),
		createdAt: nowIso,
		skill,
		origin: "manual",
	};
	db.prepare(
		"INSERT INTO eval_cases (id, target, source_run_id, input, expected, reference_feedback, scorer_spec_json, split, created_at, skill, origin) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, 'manual')",
	).run(row.id, row.target, row.input, row.expected, row.referenceFeedback, row.split, nowIso, skill);
	return row;
}

export interface RunToReview {
	runId: string;
	/** First line of the instruction, at most 120 characters. */
	instruction: string;
	/** Mean value of the latest scoring round's successful scores; null when unscored. */
	score: number | null;
	startedAt: string;
}

/** Finished, unreviewed runs of `target` that a verdict would turn into cases: lowest score first, unscored next, newest first. */
export function runsNeedingReview(db: Db, target: OptimTarget, limit = RUNS_TO_REVIEW): RunToReview[] {
	const filter = targetRunFilter(target);
	const rows = db
		.prepare(
			`SELECT r.id, r.instruction, r.started_at,
				(SELECT AVG(s.value) FROM scores s WHERE s.run_id = r.id AND s.status = 'ok' AND s.round = (SELECT MAX(s2.round) FROM scores s2 WHERE s2.run_id = r.id)) AS score
			FROM runs r WHERE ${filter.sql} AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.run_id = r.id)
			ORDER BY (score IS NULL), score ASC, r.started_at DESC, r.id DESC LIMIT ?`,
		)
		.all(...filter.args, limit);
	return rows.map((row) => {
		const first = String(row.instruction).split("\n")[0] ?? "";
		return {
			runId: String(row.id),
			instruction: first.length > 120 ? `${first.slice(0, 119)}…` : first,
			score: row.score === null ? null : Number(row.score),
			startedAt: String(row.started_at),
		};
	});
}
