import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "@nexo/telemetry";
import {
	addEvalCase,
	caseSplit,
	chooseClimbCase,
	type Db,
	getEvalCase,
	insertRun,
	insertScore,
	insertSpan,
	listEvalCases,
	listGoldens,
	normalizeCaseInput,
	openDb,
	parseOptimTarget,
	raiseGolden,
	recordFeedback,
	RunDir,
	type RunRow,
	runsNeedingReview,
	syncJudgeDisagreement,
	syncRunEvalCases,
} from "../src/index.ts";
import { runRow, scoreRow, spanRow } from "./fixtures.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const redact = createRedactor();
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A finished root run with a run directory whose run.json holds `output`. */
function finishedRun(db: Db, overrides: Partial<RunRow> = {}, output = "the answer"): RunRow {
	const root = mkdtempSync(join(tmpdir(), "nexo-eval-cases-"));
	dirs.push(root);
	const id = overrides.id ?? runRow().id;
	const dir = RunDir.create(root, id, redact);
	const run = runRow({ id, status: "succeeded", dirPath: dir.root, endedAt: NOW, ...overrides });
	insertRun(db, run);
	dir.writeRunJson({
		id: run.id,
		parentRunId: null,
		rootRunId: run.id,
		instruction: run.instruction,
		skill: run.skill,
		status: run.status,
		model: null,
		startedAt: run.startedAt,
		endedAt: NOW,
		costUsd: 0,
		costUnknown: false,
		tokensIn: 0,
		tokensOut: 0,
		output,
		error: null,
		artifactSetId: null,
		configSnapshotHash: "h",
		workspace: dir.workspaceDir,
		taskGraphs: [],
	});
	return run;
}

const verdict = (db: Db, runId: string, v: "done" | "not_done", comment = "") => recordFeedback(db, { runId, verdict: v, comment, nowIso: NOW, redact });

describe("optimization targets", () => {
	it("accepts skills, the prompts and the rubric, and refuses router_policy with a reason", () => {
		expect(parseOptimTarget("skill:ci-fix")).toEqual({ key: "skill:ci-fix", kind: "skill", name: "ci-fix" });
		expect(parseOptimTarget("system_prompt")).toEqual({ key: "system_prompt", kind: "system_prompt", name: "default" });
		expect(parseOptimTarget("planner_prompt").kind).toBe("planner_prompt");
		expect(parseOptimTarget("judge_rubric").kind).toBe("judge_rubric");
		expect(() => parseOptimTarget("router_policy")).toThrow(/router_policy is not an optimization target yet/);
		for (const bad of ["skill:", "skill:Bad_Name", "skills:x", "prompt", ""]) expect(() => parseOptimTarget(bad), bad).toThrow(/Unknown optimization target/);
	});
});

describe("syncRunEvalCases", () => {
	it("turns reviewed runs of a skill into cases with the output of done runs and the comment as feedback", () => {
		const db = openDb(":memory:");
		const target = parseOptimTarget("skill:ci-fix");
		const pinned = finishedRun(db, { instruction: "Fix the lint errors", skill: "ci-fix" }, "Fixed 3 errors");
		const loaded = finishedRun(db, { instruction: "Make CI green" }, "Tried");
		insertSpan(db, spanRow(loaded.id, { kind: "skill_load", name: "load_skill", status: "ok", attrs: { args: { name: "ci-fix" } } }));
		const other = finishedRun(db, { instruction: "Write a poem" });
		const unreviewed = finishedRun(db, { instruction: "Fix the tests", skill: "ci-fix" });
		const rollout = finishedRun(db, { instruction: "Fix it (rollout)", skill: "ci-fix", optimRunId: "01OPT" });
		const laterTurn = finishedRun(db, { instruction: "and now the docs", skill: "ci-fix", sessionId: "s1", turnIndex: 2 });
		const firstTurn = finishedRun(db, { instruction: "Fix the build", skill: "ci-fix", sessionId: "s1", turnIndex: 1 });
		verdict(db, pinned.id, "done");
		verdict(db, loaded.id, "not_done", "It never ran the tests");
		for (const r of [other, rollout, laterTurn, firstTurn]) verdict(db, r.id, "done");
		expect(syncRunEvalCases(db, target, NOW)).toEqual({ added: 3, updated: 0 });
		const cases = listEvalCases(db, "skill:ci-fix");
		expect(cases.map((c) => c.sourceRunId).sort()).toEqual([pinned.id, loaded.id, firstTurn.id].sort());
		expect(cases.find((c) => c.sourceRunId === pinned.id)).toMatchObject({ input: "Fix the lint errors", expected: "Fixed 3 errors", referenceFeedback: null, skill: "ci-fix", origin: "run" });
		expect(cases.find((c) => c.sourceRunId === loaded.id)).toMatchObject({ expected: null, referenceFeedback: "It never ran the tests", skill: null });
		expect(cases.some((c) => c.sourceRunId === unreviewed.id)).toBe(false);
		verdict(db, pinned.id, "not_done", "Missed one error");
		expect(syncRunEvalCases(db, target, NOW)).toEqual({ added: 0, updated: 3 });
		expect(listEvalCases(db, "skill:ci-fix").find((c) => c.sourceRunId === pinned.id)).toMatchObject({ expected: null, referenceFeedback: "Missed one error" });
	});

	it("makes judge_rubric cases from judged, reviewed runs with the verdict as expected, and refreshes the phase 3 split", () => {
		const db = openDb(":memory:");
		const judged = finishedRun(db, { instruction: "Summarize the doc" });
		insertScore(db, scoreRow(judged.id, { passed: true }));
		const unjudged = finishedRun(db, { instruction: "Plain run" });
		verdict(db, judged.id, "not_done", "Too long");
		verdict(db, unjudged.id, "done");
		syncJudgeDisagreement(db, judged.id, NOW);
		db.prepare("UPDATE eval_cases SET split = 'holdout'").run();
		syncRunEvalCases(db, parseOptimTarget("judge_rubric"), NOW);
		const cases = listEvalCases(db, "judge_rubric");
		expect(cases).toHaveLength(1);
		expect(cases[0]).toMatchObject({ sourceRunId: judged.id, expected: "not_done", referenceFeedback: "Too long", split: caseSplit("Summarize the doc") });
	});

	it("puts cases with the same instruction in the same split", () => {
		const db = openDb(":memory:");
		const target = parseOptimTarget("system_prompt");
		const variants = Array.from({ length: 30 }, (_, i) => `Task number ${i}: tidy the README`);
		for (const text of variants) {
			const a = finishedRun(db, { instruction: text });
			const b = finishedRun(db, { instruction: `  ${text.toUpperCase()}\n` });
			verdict(db, a.id, "done");
			verdict(db, b.id, "not_done", "no");
			addEvalCase(db, { target: "system_prompt", input: text.replace(" ", "   ") }, redact, NOW);
		}
		syncRunEvalCases(db, target, NOW);
		const cases = listEvalCases(db, "system_prompt");
		expect(cases).toHaveLength(90);
		const splitOf = new Map<string, Set<string>>();
		for (const c of cases) {
			const key = normalizeCaseInput(c.input);
			splitOf.set(key, (splitOf.get(key) ?? new Set()).add(c.split));
		}
		expect(splitOf.size).toBe(30);
		for (const [key, splits] of splitOf) expect(splits.size, key).toBe(1);
		expect(new Set(cases.map((c) => c.split))).toEqual(new Set(["feedback", "pareto", "holdout"]));
	});
});

describe("addEvalCase", () => {
	it("stores a redacted manual case and validates target, input, skill and lengths", () => {
		const db = openDb(":memory:");
		const row = addEvalCase(db, { target: "skill:ci-fix", input: "  Use key sk-abcdefghijklmnopqrstuvwxyz to deploy ", expected: "Deployed" }, redact, NOW);
		expect(row).toMatchObject({ origin: "manual", skill: "ci-fix", sourceRunId: null, expected: "Deployed" });
		expect(row.input).not.toContain("sk-abcdefghijklmnop");
		expect(listEvalCases(db, "skill:ci-fix")).toEqual([row]);
		expect(() => addEvalCase(db, { target: "judge_rubric", input: "x" }, redact, NOW)).toThrow(/judge_rubric cases come from reviewed runs/);
		expect(() => addEvalCase(db, { target: "system_prompt", input: "   " }, redact, NOW)).toThrow(/empty/);
		expect(() => addEvalCase(db, { target: "system_prompt", input: "x".repeat(20_001) }, redact, NOW)).toThrow(/longer than 20000/);
		expect(() => addEvalCase(db, { target: "skill:ci-fix", input: "x", skill: "other" }, redact, NOW)).toThrow(/always runs with skill ci-fix/);
		expect(addEvalCase(db, { target: "system_prompt", input: "x", skill: "browser" }, redact, NOW).skill).toBe("browser");
	});
});

describe("runsNeedingReview", () => {
	it("lists unreviewed runs of the target, lowest score first, then unscored, newest first", () => {
		const db = openDb(":memory:");
		const target = parseOptimTarget("system_prompt");
		const high = finishedRun(db, { instruction: "high", startedAt: "2026-10-10T00:00:00.000Z" });
		const low = finishedRun(db, { instruction: "low\nsecond line", startedAt: "2026-10-09T00:00:00.000Z" });
		const older = finishedRun(db, { instruction: "older unscored", startedAt: "2026-10-01T00:00:00.000Z" });
		const newer = finishedRun(db, { instruction: "newer unscored", startedAt: "2026-10-11T00:00:00.000Z" });
		const reviewed = finishedRun(db, { instruction: "reviewed" });
		insertScore(db, scoreRow(high.id, { value: 0.9 }));
		insertScore(db, scoreRow(low.id, { value: 0.2 }));
		verdict(db, reviewed.id, "done");
		const list = runsNeedingReview(db, target);
		expect(list.map((r) => r.runId)).toEqual([low.id, high.id, newer.id, older.id]);
		expect(list[0]).toMatchObject({ instruction: "low", score: 0.2 });
		expect(runsNeedingReview(db, target, 1)).toHaveLength(1);
	});
});

describe("the sync guard", () => {
	it("keeps a golden that climb raised when the source run's done output changes", () => {
		const db = openDb(":memory:");
		const run = finishedRun(db, { skill: "ci-fix", instruction: "Fix CI" }, "first output");
		verdict(db, run.id, "done");
		syncRunEvalCases(db, parseOptimTarget("skill:ci-fix"), NOW);
		const [c] = listEvalCases(db, "skill:ci-fix");
		expect(c).toMatchObject({ expected: "first output", goldenSource: "run" });
		raiseGolden(db, { caseId: c!.id, expected: "climbed output", sourceRunId: "R9", optimRunId: "O1", redact, nowIso: NOW });
		verdict(db, run.id, "done", "even better now");
		syncRunEvalCases(db, parseOptimTarget("skill:ci-fix"), NOW);
		expect(getEvalCase(db, c!.id)).toMatchObject({ expected: "climbed output", goldenSource: "climb", referenceFeedback: "even better now" });
	});

	it("records a history row only when a run golden changes", () => {
		const db = openDb(":memory:");
		const run = finishedRun(db, { skill: "ci-fix", instruction: "Fix CI" }, "out");
		verdict(db, run.id, "done");
		syncRunEvalCases(db, parseOptimTarget("skill:ci-fix"), NOW);
		syncRunEvalCases(db, parseOptimTarget("skill:ci-fix"), NOW);
		const [c] = listEvalCases(db, "skill:ci-fix");
		expect(listGoldens(db, c!.id)).toHaveLength(1);
		verdict(db, run.id, "not_done");
		syncRunEvalCases(db, parseOptimTarget("skill:ci-fix"), NOW);
		expect(getEvalCase(db, c!.id)).toMatchObject({ expected: null, goldenSource: null });
	});

	it("activates a proposed mined case when its leader run gets a verdict", () => {
		const db = openDb(":memory:");
		const run = finishedRun(db, { skill: "ci-fix", instruction: "Fix CI" }, "leader output");
		db.prepare("INSERT INTO eval_cases (id, target, source_run_id, input, split, created_at, skill, origin, status, mined_from_json) VALUES ('M1', 'skill:ci-fix', ?, 'Fix CI', 'pareto', ?, 'ci-fix', 'mined', 'proposed', '[]')").run(run.id, NOW);
		verdict(db, run.id, "done");
		syncRunEvalCases(db, parseOptimTarget("skill:ci-fix"), NOW);
		expect(getEvalCase(db, "M1")).toMatchObject({ origin: "mined", status: "active", expected: "leader output", goldenSource: "run" });
	});
});

describe("chooseClimbCase", () => {
	it("picks the newest active case with a golden not yet climbed against the base, and explains every refusal", () => {
		const db = openDb(":memory:");
		const target = parseOptimTarget("skill:ci-fix");
		expect(() => chooseClimbCase(db, target, "BASE")).toThrow(expect.objectContaining({ code: "EVAL_SET_TOO_SMALL" }));
		const older = addEvalCase(db, { target: "skill:ci-fix", input: "a", expected: "A" }, redact, "2026-10-01T00:00:00.000Z");
		const newer = addEvalCase(db, { target: "skill:ci-fix", input: "b", expected: "B" }, redact, "2026-10-02T00:00:00.000Z");
		addEvalCase(db, { target: "skill:ci-fix", input: "no golden" }, redact, "2026-10-03T00:00:00.000Z");
		expect(chooseClimbCase(db, target, "BASE").id).toBe(newer.id);
		db.prepare("INSERT INTO artifacts (id, kind, name, version, content, content_hash, status, origin, parent_version_id, created_at) VALUES ('BASE', 'skill', 'ci-fix', 1, 'x', 'h', 'active', 'manual', NULL, ?)").run(NOW);
		db.prepare("INSERT INTO optim_runs (id, target, status, budget_usd, seed, base_artifact_id, dir_path, created_at, mode, case_id) VALUES ('O1', 'skill:ci-fix', 'succeeded', 1, 1, 'BASE', '/tmp', ?, 'climb', ?)").run(NOW, newer.id);
		expect(chooseClimbCase(db, target, "BASE").id).toBe(older.id);
		db.prepare("INSERT INTO optim_runs (id, target, status, budget_usd, seed, base_artifact_id, dir_path, created_at, mode, case_id) VALUES ('O2', 'skill:ci-fix', 'succeeded', 1, 1, 'BASE', '/tmp', ?, 'climb', ?)").run(NOW, older.id);
		expect(() => chooseClimbCase(db, target, "BASE")).toThrow(expect.objectContaining({ code: "CONFLICT" }));
		expect(chooseClimbCase(db, target, "BASE", older.id).id).toBe(older.id);
		expect(() => chooseClimbCase(db, target, "BASE", "NOPE")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
		const other = addEvalCase(db, { target: "system_prompt", input: "c", expected: "C" }, redact, NOW);
		expect(() => chooseClimbCase(db, target, "BASE", other.id)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
	});
});
