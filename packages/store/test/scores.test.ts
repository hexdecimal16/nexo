import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	costReport,
	ensureManualArtifact,
	ensureSeedArtifact,
	getActiveArtifact,
	getRun,
	insertRun,
	insertScore,
	insertSpan,
	listScores,
	openDb,
	queryRuns,
	reindex,
} from "../src/index.ts";
import { runRow, scoreRow, spanRow } from "./fixtures.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("scores", () => {
	it("stores and reads scores with their JSON fields, by round", () => {
		const db = openDb(":memory:");
		const run = runRow({ status: "succeeded" });
		insertRun(db, run);
		const failed = scoreRow(run.id, { scorerKind: "deterministic", scorerType: "command", scorerName: "tests", status: "failed", value: null, passed: null, criteria: null, error: { code: "SCORER_FAILED", message: "timed out", retryable: false }, model: null });
		insertScore(db, failed);
		insertScore(db, scoreRow(run.id, { round: 1, value: 0.4, passed: false }));
		expect(listScores(db, run.id).map((s) => [s.round, s.scorerName, s.status, s.value, s.passed])).toEqual([
			[0, "tests", "failed", null, null],
			[1, "llm_judge", "ok", 0.4, false],
		]);
		expect(listScores(db, run.id)[0]?.error).toEqual({ code: "SCORER_FAILED", message: "timed out", retryable: false });
	});

	it("summarizes the latest round on run summaries and filters by scored", () => {
		const db = openDb(":memory:");
		const scored = runRow({ status: "succeeded", startedAt: "2026-10-10T00:00:02.000Z" });
		const unscored = runRow({ status: "succeeded", startedAt: "2026-10-10T00:00:01.000Z" });
		const running = runRow({ status: "running", startedAt: "2026-10-10T00:00:03.000Z" });
		for (const r of [scored, unscored, running]) insertRun(db, r);
		insertScore(db, scoreRow(scored.id, { round: 0, value: 0.2, passed: false }));
		insertScore(db, scoreRow(scored.id, { round: 1, value: 1, passed: true, scorerKind: "deterministic", scorerType: "contains", scorerName: "says-done" }));
		insertScore(db, scoreRow(scored.id, { round: 1, value: 0.6, passed: true }));
		insertScore(db, scoreRow(scored.id, { round: 1, status: "failed", value: null, passed: null, scorerName: "broken" }));
		const page = queryRuns(db);
		const summary = page.runs.find((r) => r.id === scored.id);
		expect(summary?.score).toEqual({ value: 0.8, passed: true, scorers: 2, failedScorers: 1 });
		expect(page.runs.find((r) => r.id === unscored.id)?.score).toBeNull();
		expect(queryRuns(db, { scored: true }).runs.map((r) => r.id)).toEqual([scored.id]);
		expect(queryRuns(db, { scored: false }).runs.map((r) => r.id)).toEqual([unscored.id]);
	});

	it("reports a run whose every scorer failed with a null value and verdict", () => {
		const db = openDb(":memory:");
		const run = runRow({ status: "succeeded" });
		insertRun(db, run);
		insertScore(db, scoreRow(run.id, { status: "failed", value: null, passed: null }));
		expect(queryRuns(db).runs[0]?.score).toEqual({ value: null, passed: null, scorers: 0, failedScorers: 1 });
	});

	it("keeps scores through reindex and restores them, and escalations, from run.json", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-scores-"));
		tempDirs.push(root);
		const id = "01J0000000000000000000000B";
		mkdirSync(join(root, id), { recursive: true });
		const row = scoreRow(id, { id: "01J0000000000000000000000S" });
		writeFileSync(
			join(root, id, "run.json"),
			JSON.stringify({
				id, parentRunId: null, rootRunId: id, instruction: "x", skill: null, status: "succeeded", model: null,
				startedAt: "2026-10-10T00:00:00.000Z", endedAt: "2026-10-10T00:00:01.000Z", costUsd: 0, costUnknown: false,
				tokensIn: 0, tokensOut: 0, output: "", error: null, artifactSetId: null, configSnapshotHash: "h", workspace: "/w",
				taskGraphs: [], scores: [row], escalations: 1,
			}),
		);
		const db = openDb(":memory:");
		reindex(db, root);
		expect(listScores(db, id)).toEqual([row]);
		expect(getRun(db, id)?.escalations).toBe(1);
		reindex(db, root);
		expect(listScores(db, id)).toHaveLength(1);
	});

	it("counts judge and self-check calls in the cost report", () => {
		const db = openDb(":memory:");
		const run = runRow({ status: "succeeded", startedAt: "2026-10-10T00:00:00.000Z" });
		insertRun(db, run);
		insertSpan(db, spanRow(run.id, { costUsd: 0.01, startedAt: "2026-10-10T00:00:01.000Z" }));
		insertSpan(db, spanRow(run.id, { kind: "judge_call", tier: "judge", costUsd: 0.02, startedAt: "2026-10-10T00:00:02.000Z" }));
		insertSpan(db, spanRow(run.id, { kind: "self_check", costUsd: 0.04, startedAt: "2026-10-10T00:00:03.000Z" }));
		insertSpan(db, spanRow(run.id, { kind: "scorer", costUsd: 0, startedAt: "2026-10-10T00:00:04.000Z" }));
		const report = costReport(db, { by: "tier", since: "2026-10-01", now: new Date("2026-10-11T00:00:00.000Z") });
		expect(report.totalUsd).toBeCloseTo(0.07);
		expect(report.rows.find((r) => r.key === "judge")?.costUsd).toBeCloseTo(0.02);
	});
});

describe("ensureSeedArtifact", () => {
	it("seeds version 1 once and never replaces an active version", () => {
		const db = openDb(":memory:");
		const seeded = ensureSeedArtifact(db, "router_policy", "default", "{}", "2026-10-11T00:00:00.000Z");
		expect(seeded).toMatchObject({ version: 1, status: "active", origin: "manual" });
		const promoted = ensureManualArtifact(db, "router_policy", "default", '{"triggers":{}}', "2026-10-11T00:00:01.000Z");
		expect(ensureSeedArtifact(db, "router_policy", "default", "{}", "2026-10-11T00:00:02.000Z").id).toBe(promoted.id);
		expect(getActiveArtifact(db, "router_policy", "default")?.version).toBe(2);
	});
});
