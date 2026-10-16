import type { SQLInputValue } from "node:sqlite";
import type { Redactor } from "@nexo/telemetry";
import { NexoError } from "@nexo/telemetry";
import { type Db, transaction } from "./db.ts";
import { invalidRequest } from "./errors.ts";
import { latestFeedback } from "./feedback.ts";
import { recordGolden } from "./goldens.ts";
import { newId } from "./ids.ts";
import { type EvalCaseRow, type EvalSplit, evalSplitFor, getEvalCase, listActiveEvalCases, listEvalCases } from "./judge-calibration.ts";
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
			const rubric = target.kind === "judge_rubric";
			const existing = db.prepare("SELECT id, expected, golden_source FROM eval_cases WHERE target = ? AND source_run_id = ?").get(target.key, id);
			if (existing) {
				const caseId = String(existing.id);
				if (existing.golden_source === "climb" || existing.golden_source === "manual") {
					// Goldens from climb or a human are not replaced by the run's output. Only a proposed case becomes active.
					db.prepare("UPDATE eval_cases SET reference_feedback = ?, skill = ?, status = CASE WHEN status = 'proposed' THEN 'active' ELSE status END WHERE id = ?").run(reference, run.skill, caseId);
				} else {
					db.prepare("UPDATE eval_cases SET expected = ?, reference_feedback = ?, skill = ?, status = CASE WHEN status = 'proposed' THEN 'active' ELSE status END, golden_source = ? WHERE id = ?").run(
						expected,
						reference,
						run.skill,
						!rubric && expected !== null ? "run" : null,
						caseId,
					);
					if (!rubric && expected !== null && expected !== existing.expected) recordGolden(db, { caseId, expected, source: "run", sourceRunId: id, nowIso });
				}
				updated++;
			} else {
				const caseId = newId();
				db.prepare(
					"INSERT INTO eval_cases (id, target, source_run_id, input, expected, reference_feedback, scorer_spec_json, split, created_at, skill, origin, status, golden_source) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'run', 'active', ?)",
				).run(caseId, target.key, id, run.instruction, expected, reference, caseSplit(run.instruction), nowIso, run.skill, !rubric && expected !== null ? "run" : null);
				if (!rubric && expected !== null) recordGolden(db, { caseId, expected, source: "run", sourceRunId: id, nowIso });
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
		status: "active",
		goldenSource: input.expected?.trim() ? "manual" : null,
		minedFrom: null,
	};
	transaction(db, () => {
		db.prepare(
			"INSERT INTO eval_cases (id, target, source_run_id, input, expected, reference_feedback, scorer_spec_json, split, created_at, skill, origin, status, golden_source) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, 'manual', 'active', ?)",
		).run(row.id, row.target, row.input, row.expected, row.referenceFeedback, row.split, nowIso, skill, row.goldenSource);
		if (row.expected !== null) recordGolden(db, { caseId: row.id, expected: row.expected, source: "manual", nowIso });
	});
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

/**
 * The user's decision on a proposed (mined) case: `accept` makes it active, optionally with a golden; `dismiss` keeps it
 * out of optimizations and stops its cluster from being proposed again. Throws NOT_FOUND, CONFLICT (not proposed) or
 * INVALID_REQUEST (golden too long).
 */
export function reviewProposedCase(db: Db, id: string, decision: "accept" | "dismiss", options: { expected?: string | null; redact: Redactor; nowIso: string }): EvalCaseRow {
	const golden = options.expected?.trim() ? options.redact(options.expected.trim()) : null;
	if (golden && golden.length > MAX_EVAL_INPUT_CHARS) throw invalidRequest(`expected is longer than ${MAX_EVAL_INPUT_CHARS} characters`, { length: golden.length });
	return transaction(db, () => {
		const c = getEvalCase(db, id);
		if (!c) throw new NexoError({ code: "NOT_FOUND", message: `Eval case ${id} does not exist`, context: { caseId: id } });
		if (c.status !== "proposed") throw new NexoError({ code: "CONFLICT", message: `Eval case ${id} is ${c.status}, not proposed`, context: { caseId: id, status: c.status } });
		if (decision === "dismiss") {
			db.prepare("UPDATE eval_cases SET status = 'dismissed' WHERE id = ?").run(id);
		} else if (golden) {
			db.prepare("UPDATE eval_cases SET status = 'active', expected = ?, golden_source = 'manual' WHERE id = ?").run(golden, id);
			recordGolden(db, { caseId: id, expected: golden, source: "manual", nowIso: options.nowIso });
		} else {
			db.prepare("UPDATE eval_cases SET status = 'active' WHERE id = ?").run(id);
		}
		return getEvalCase(db, id) as EvalCaseRow;
	});
}

/**
 * The case a climb runs on (design §4.2). With `caseId`: that case, which must be an active case of `target` with a
 * golden. Without: the newest such case with no succeeded climb against `baseArtifactId`. Throws NOT_FOUND,
 * INVALID_REQUEST, EVAL_SET_TOO_SMALL (no case has a golden) or CONFLICT (every case was climbed against this base).
 */
export function chooseClimbCase(db: Db, target: OptimTarget, baseArtifactId: string, caseId?: string): EvalCaseRow {
	if (caseId !== undefined) {
		const c = getEvalCase(db, caseId);
		if (!c) throw new NexoError({ code: "NOT_FOUND", message: `Eval case ${caseId} does not exist`, context: { caseId }, hint: `List cases with \`nexo eval list --target ${target.key}\`` });
		if (c.target !== target.key) throw invalidRequest(`Eval case ${caseId} belongs to ${c.target}, not ${target.key}`, { caseId });
		if (c.status !== "active") throw invalidRequest(`Eval case ${caseId} is ${c.status}; climb needs an active case`, { caseId }, `Accept it with \`nexo eval accept ${caseId}\``);
		if (c.expected === null) throw invalidRequest(`Eval case ${caseId} has no golden (expected output)`, { caseId }, "Mark a run of this instruction done, or accept it with --expected");
		return c;
	}
	const withGolden = listActiveEvalCases(db, target.key).filter((c) => c.expected !== null);
	if (withGolden.length === 0) {
		const runsToReview = runsNeedingReview(db, target).map((r) => r.runId);
		const proposed = listEvalCases(db, target.key).filter((c) => c.status === "proposed").map((c) => c.id);
		throw new NexoError({
			code: "EVAL_SET_TOO_SMALL",
			message: `Climbing ${target.key} needs an active eval case with a golden (a run marked done); it has none`,
			hint: runsToReview.length > 0 ? `Mark one of these runs done: ${runsToReview.join(", ")}` : `Add one with \`nexo eval add --target ${target.key} --input "<instruction>" --expected "<answer>"\``,
			context: { target: target.key, runsToReview, proposedCases: proposed },
		});
	}
	const climbed = new Set(
		db
			.prepare("SELECT case_id FROM optim_runs WHERE mode = 'climb' AND status = 'succeeded' AND base_artifact_id = ? AND case_id IS NOT NULL")
			.all(baseArtifactId)
			.map((row) => String(row.case_id)),
	);
	const next = [...withGolden].reverse().find((c) => !climbed.has(c.id));
	if (!next) {
		throw new NexoError({
			code: "CONFLICT",
			message: `Every eval case of ${target.key} with a golden was already climbed against the current version`,
			hint: "Pass --case <id> to climb one again, or add cases",
			context: { target: target.key, baseArtifactId },
		});
	}
	return next;
}
