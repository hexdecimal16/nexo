import { describe, expect, it } from "vitest";
import { createRedactor } from "@nexo/telemetry";
import {
	agreementStats,
	confusionMatrix,
	evalSplitFor,
	insertRun,
	insertScore,
	JUDGE_CASE_TARGET,
	judgeDisagrees,
	judgeHumanPairs,
	listCalibrations,
	listDisagreements,
	listEvalCases,
	openDb,
	recordCalibration,
	recordFeedback,
} from "../src/index.ts";
import { runRow, scoreRow } from "./fixtures.ts";

const redact = createRedactor();

function judged(db: ReturnType<typeof openDb>, passed: boolean, model = "google/gemini-x") {
	const run = runRow({ status: "succeeded", instruction: `task ${passed}` });
	insertRun(db, run);
	insertScore(db, scoreRow(run.id, { passed, value: passed ? 0.9 : 0.2, model }));
	return run.id;
}

function review(db: ReturnType<typeof openDb>, runId: string, verdict: "done" | "not_done", comment = "", nowIso = "2026-10-11T00:00:00.000Z") {
	return recordFeedback(db, { runId, verdict, comment, nowIso, redact });
}

describe("Cohen's kappa", () => {
	it("computes accuracy and kappa from a confusion matrix", () => {
		expect(agreementStats({ bothPass: 20, judgePassHumanFail: 5, judgeFailHumanPass: 10, bothFail: 15 })).toEqual({
			cases: 50,
			agreements: 35,
			accuracy: 0.7,
			kappa: expect.closeTo(0.4, 10),
		});
		expect(agreementStats({ bothPass: 0, judgePassHumanFail: 0, judgeFailHumanPass: 0, bothFail: 0 })).toEqual({ cases: 0, agreements: 0, accuracy: null, kappa: null });
		expect(agreementStats({ bothPass: 4, judgePassHumanFail: 0, judgeFailHumanPass: 0, bothFail: 0 }).kappa).toBeNull();
		expect(agreementStats({ bothPass: 0, judgePassHumanFail: 3, judgeFailHumanPass: 3, bothFail: 0 }).kappa).toBe(-1);
	});

	it("splits eval cases 40/40/20 stably by key", () => {
		const counts = { feedback: 0, pareto: 0, holdout: 0 };
		for (let i = 0; i < 2000; i++) counts[evalSplitFor(`run-${i}`)]++;
		expect(counts.feedback / 2000).toBeCloseTo(0.4, 1);
		expect(counts.holdout / 2000).toBeCloseTo(0.2, 1);
		expect(evalSplitFor("run-7")).toBe(evalSplitFor("run-7"));
	});
});

describe("judge and human verdicts", () => {
	it("pairs the latest judge verdict with the latest human verdict and stores a calibration", () => {
		const db = openDb(":memory:");
		const a = judged(db, true);
		const b = judged(db, false);
		const c = judged(db, true);
		judged(db, true);
		const other = judged(db, false, "openai/gpt-x");
		review(db, a, "done");
		review(db, b, "not_done");
		review(db, c, "not_done", "wrong file");
		review(db, other, "done");
		expect(judgeHumanPairs(db, "google/gemini-x")).toHaveLength(3);
		expect(confusionMatrix(judgeHumanPairs(db, "google/gemini-x"))).toEqual({ bothPass: 1, judgePassHumanFail: 1, judgeFailHumanPass: 0, bothFail: 1 });
		const cal = recordCalibration(db, "google/gemini-x", "2026-10-11T01:00:00.000Z");
		expect(cal).toMatchObject({ judgeKey: "google/gemini-x", cases: 3, agreements: 2 });
		expect(cal.accuracy).toBeCloseTo(2 / 3);
		expect(listCalibrations(db)).toEqual([cal]);
		expect(listCalibrations(db, { judgeKey: "openai/gpt-x" })).toEqual([]);
	});

	it("flags a disagreement and turns it into a judge_rubric eval case that follows the latest verdict", () => {
		const db = openDb(":memory:");
		const run = judged(db, true);
		expect(judgeDisagrees(db, run)).toBe(false);
		review(db, run, "not_done", "missed the second file", "2026-10-11T00:00:00.000Z");
		expect(judgeDisagrees(db, run)).toBe(true);
		const [first] = listEvalCases(db, JUDGE_CASE_TARGET);
		expect(first).toMatchObject({ sourceRunId: run, input: "task true", expected: "not_done", referenceFeedback: "missed the second file", split: evalSplitFor(run) });
		expect(listDisagreements(db)).toEqual([expect.objectContaining({ runId: run, judgePassed: true, verdict: "not_done", comment: "missed the second file" })]);
		review(db, run, "done", "", "2026-10-11T00:01:00.000Z");
		expect(judgeDisagrees(db, run)).toBe(false);
		expect(listEvalCases(db, JUDGE_CASE_TARGET)).toEqual([expect.objectContaining({ id: first?.id, expected: "done", referenceFeedback: "" })]);
		expect(listDisagreements(db)).toEqual([]);
	});

	it("adds no eval case when the verdicts agree or the run has no judge score", () => {
		const db = openDb(":memory:");
		const agreed = judged(db, false);
		review(db, agreed, "not_done");
		const plain = runRow({ status: "succeeded" });
		insertRun(db, plain);
		review(db, plain.id, "done");
		expect(listEvalCases(db, JUDGE_CASE_TARGET)).toEqual([]);
	});
});
