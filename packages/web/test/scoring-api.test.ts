import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, insertRun, insertScore, insertSpan, openDb, recordCalibration, recordFeedback, RunDir, type RunRow } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { runRow, scoreRow, spanRow } from "../../store/test/fixtures.ts";
import type { JudgeCalibrationResponse, RunDetailResponse, RunListResponse } from "../public/lib/api-types.ts";
import { startWebServer, type WebServer } from "../src/index.ts";
import { raw } from "./http.ts";

const JUDGE = "google/gemini-x";
let home: string;
let db: Db;
let server: WebServer;
let bare: WebServer;
let judged: RunRow;
let unscored: RunRow;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "nexo-web-scores-"));
	db = openDb(join(home, "nexo.db"));
	const redact = createRedactor();
	const make = (overrides: Partial<RunRow>) => {
		const base = runRow({ status: "succeeded", ...overrides });
		const dir = RunDir.create(join(home, "runs"), base.id, redact);
		const row = { ...base, dirPath: dir.root };
		insertRun(db, row);
		return row;
	};
	judged = make({ instruction: "judged task", startedAt: "2026-10-10T10:00:00.000Z", escalations: 1 });
	unscored = make({ instruction: "plain task", startedAt: "2026-10-10T09:00:00.000Z" });
	insertScore(db, scoreRow(judged.id, { round: 0, value: 0.3, passed: false, model: JUDGE }));
	insertScore(db, scoreRow(judged.id, { round: 1, value: 0.9, passed: true, model: JUDGE, details: { rubric: "RUBRIC TEXT", sameFamily: [{ judge: JUDGE, generator: "google/gemini-y", family: "google" }] } }));
	const runSpan = spanRow(judged.id, { kind: "run", name: "run", status: "ok" });
	insertSpan(db, runSpan);
	insertSpan(
		db,
		spanRow(judged.id, {
			kind: "escalation",
			name: "judge_low",
			parentSpanId: runSpan.id,
			status: "ok",
			startedAt: "2026-10-10T10:00:05.000Z",
			attrs: { trigger: "judge_low", reason: "judge score 0.30 is below 0.6", phase: "end_of_run", applied: true, blockedBy: null, from: "faux/fast", to: "faux/slow" },
		}),
	);
	const spanAt = (name: string, attrs: Record<string, unknown>, startedAt: string) =>
		insertSpan(db, spanRow(judged.id, { kind: "escalation", name, parentSpanId: runSpan.id, status: "ok", startedAt, attrs }));
	spanAt("tool_failures", { trigger: "tool_failures", reason: "2 failures", phase: "mid_run", applied: false, blockedBy: "max_escalations", blockedReason: "limit reached", from: null, to: null }, "2026-10-10T10:00:06.000Z");
	spanAt("verify_fail", { trigger: "verify_fail", reason: "check failed", phase: "end_of_run", applied: true, blockedBy: null, from: "faux/fast", to: "faux/slow", continuationError: { code: "INTERNAL", message: "continuation ended failed" } }, "2026-10-10T10:00:07.000Z");
	spanAt("stagnation", { trigger: "stagnation", reason: "same", phase: "mid_run", applied: true, blockedBy: null, from: "a", to: "b", continuationError: { code: 5, message: "x" } }, "2026-10-10T10:00:08.000Z");
	recordFeedback(db, { runId: judged.id, verdict: "not_done", comment: "still wrong", nowIso: "2026-10-11T00:00:00.000Z", redact });
	recordCalibration(db, JUDGE, "2026-10-11T00:01:00.000Z");
	server = await startWebServer({ db, redact, port: 0, judge: { key: JUDGE, warnings: ["Judge google/gemini-x is from the same model family"] } });
	bare = await startWebServer({ db, redact, port: 0 });
});

afterAll(async () => {
	await server.close();
	await bare.close();
	db.close();
	rmSync(home, { recursive: true, force: true });
});

describe("scores in the runs API", () => {
	it("filters by scored and summarizes the latest round", async () => {
		const scored = (await raw(server.port, "/api/runs?scored=true")).json() as RunListResponse;
		expect(scored.runs.map((r) => r.id)).toEqual([judged.id]);
		expect(scored.runs[0]?.score).toEqual({ value: 0.9, passed: true, scorers: 1, failedScorers: 0 });
		expect(((await raw(server.port, "/api/runs?scored=false")).json() as RunListResponse).runs.map((r) => r.id)).toEqual([unscored.id]);
		const bad = await raw(server.port, "/api/runs?scored=1");
		expect(bad.status).toBe(400);
		expect(bad.json().error).toMatchObject({ code: "INVALID_REQUEST", message: "scored must be true or false" });
	});

	it("returns every score, the escalations and the judge/human disagreement on the run detail", async () => {
		const detail = (await raw(server.port, `/api/runs/${judged.id}`)).json() as RunDetailResponse;
		expect(detail.scores.map((s) => [s.round, s.value, s.passed])).toEqual([
			[0, 0.3, false],
			[1, 0.9, true],
		]);
		const esc = detail.escalations.map(({ spanId: _s, at: _a, ...rest }) => rest);
		expect(esc).toEqual([
			{ trigger: "judge_low", reason: "judge score 0.30 is below 0.6", phase: "end_of_run", applied: true, blockedBy: null, blockedReason: null, from: "faux/fast", to: "faux/slow", continuationError: null },
			{ trigger: "tool_failures", reason: "2 failures", phase: "mid_run", applied: false, blockedBy: "max_escalations", blockedReason: "limit reached", from: null, to: null, continuationError: null },
			{ trigger: "verify_fail", reason: "check failed", phase: "end_of_run", applied: true, blockedBy: null, blockedReason: null, from: "faux/fast", to: "faux/slow", continuationError: { code: "INTERNAL", message: "continuation ended failed" } },
			{ trigger: "stagnation", reason: "same", phase: "mid_run", applied: true, blockedBy: null, blockedReason: null, from: "a", to: "b", continuationError: null },
		]);
		expect(detail.scores.every((s) => !("rubric" in s.details))).toBe(true);
		expect(detail.scores[1]?.details).toHaveProperty("sameFamily");
		expect(detail.judgeDisagrees).toBe(true);
		const plain = (await raw(server.port, `/api/runs/${unscored.id}`)).json() as RunDetailResponse;
		expect(plain).toMatchObject({ scores: [], escalations: [], judgeDisagrees: false });
	});
});

describe("GET /api/judge/calibration", () => {
	it("returns the configured judge, its warnings, live agreement, stored results and disagreements", async () => {
		const res = await raw(server.port, "/api/judge/calibration");
		expect(res.status).toBe(200);
		const body = res.json() as JudgeCalibrationResponse;
		expect(body.judgeKey).toBe(JUDGE);
		expect(body.warnings).toEqual(["Judge google/gemini-x is from the same model family"]);
		expect(body.current).toMatchObject({ cases: 1, agreements: 0, accuracy: 0, matrix: { judgePassHumanFail: 1 } });
		expect(body.history).toEqual([expect.objectContaining({ judgeKey: JUDGE, cases: 1 })]);
		expect(body.disagreements).toEqual([expect.objectContaining({ runId: judged.id, judgePassed: true, verdict: "not_done", comment: "still wrong" })]);
	});

	it("works without a configured judge and refuses other methods", async () => {
		const body = (await raw(bare.port, "/api/judge/calibration")).json() as JudgeCalibrationResponse;
		expect(body).toMatchObject({ judgeKey: null, warnings: [], current: null });
		expect(body.history).toHaveLength(1);
		const post = await raw(server.port, "/api/judge/calibration", { method: "POST", headers: { "content-type": "application/json", "x-nexo-token": server.token }, body: "{}" });
		expect(post.status).toBe(405);
	});
});
