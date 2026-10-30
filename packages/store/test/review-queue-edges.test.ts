import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { insertRun, insertScore, openDb, reviewQueue } from "../src/index.ts";
import { runRow, scoreRow } from "./fixtures.ts";

const NOW = new Date("2026-10-30T00:00:00.000Z");
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed() {
	const db = openDb(":memory:");
	const root = mkdtempSync(join(tmpdir(), "nexo-rqe-"));
	dirs.push(root);
	const add = (id: string, overrides: Parameters<typeof runRow>[0] = {}) => {
		const dir = join(root, id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "run.json"), JSON.stringify({ id }));
		insertRun(db, runRow({ id, dirPath: dir, status: "succeeded", startedAt: "2026-10-29T00:00:00.000Z", ...overrides }));
	};
	return { db, add };
}

describe("reviewQueue edge cases", () => {
	it("treats a score of exactly 0.6 as ok and 0.59 as low", () => {
		const { db, add } = seed();
		add("edge");
		insertScore(db, scoreRow("edge", { value: 0.6 }));
		add("below");
		insertScore(db, scoreRow("below", { value: 0.59 }));
		const modes = Object.fromEntries(reviewQueue(db, { now: NOW }).map((i) => [i.runId, i.failureMode]));
		expect(modes).toEqual({ edge: "ok", below: "low_score" });
	});

	it("uses only the latest scoring round and ignores failed scores", () => {
		const { db, add } = seed();
		add("rescored");
		insertScore(db, scoreRow("rescored", { round: 0, value: 0.1 }));
		insertScore(db, scoreRow("rescored", { round: 1, value: 0.9 }));
		add("brokenScorer");
		insertScore(db, scoreRow("brokenScorer", { status: "failed", value: null, passed: null }));
		const byId = Object.fromEntries(reviewQueue(db, { now: NOW }).map((i) => [i.runId, i]));
		expect(byId.rescored).toMatchObject({ failureMode: "ok" });
		expect(byId.rescored?.score).toBeCloseTo(0.9);
		expect(byId.brokenScorer).toMatchObject({ failureMode: "unscored", score: null });
	});

	it("returns a null error code for malformed or code-less error JSON", () => {
		const { db, add } = seed();
		add("bad", { status: "failed" });
		add("nocode", { status: "failed" });
		db.prepare("UPDATE runs SET error_json = '{not json' WHERE id = 'bad'").run();
		db.prepare("UPDATE runs SET error_json = '{\"message\":\"x\"}' WHERE id = 'nocode'").run();
		expect(reviewQueue(db, { now: NOW }).map((i) => i.errorCode)).toEqual([null, null]);
	});

	it("orders runs of the same failure mode by cost, then newest first", () => {
		const { db, add } = seed();
		add("cheap", { status: "failed", costUsd: 0.01 });
		add("dear", { status: "failed", costUsd: 0.5 });
		add("older", { status: "failed", costUsd: 0.01, startedAt: "2026-10-28T00:00:00.000Z" });
		expect(reviewQueue(db, { now: NOW }).map((i) => i.runId)).toEqual(["dear", "cheap", "older"]);
	});

	it("includes a run started exactly at the window start and clamps limit above 100", () => {
		const { db, add } = seed();
		add("boundary", { startedAt: "2026-10-23T00:00:00.000Z" });
		add("before", { startedAt: "2026-10-22T23:59:59.999Z" });
		expect(reviewQueue(db, { now: NOW, limit: 1000 }).map((i) => i.runId)).toEqual(["boundary"]);
	});

	it("returns an empty list for an empty database", () => {
		expect(reviewQueue(openDb(":memory:"), { now: NOW })).toEqual([]);
	});
});
