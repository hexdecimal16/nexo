import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "@nexo/telemetry";
import { insertRun, insertScore, openDb, recordFeedback, reviewQueue } from "../src/index.ts";
import { runRow, scoreRow } from "./fixtures.ts";

const redact = createRedactor();
const NOW = new Date("2026-10-30T00:00:00.000Z");
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed() {
	const db = openDb(":memory:");
	const root = mkdtempSync(join(tmpdir(), "nexo-rq-"));
	dirs.push(root);
	const add = (id: string, overrides: Parameters<typeof runRow>[0], score?: number) => {
		const dir = join(root, id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "run.json"), JSON.stringify({ id }));
		insertRun(db, runRow({ id, dirPath: dir, startedAt: "2026-10-29T00:00:00.000Z", ...overrides }));
		if (score !== undefined) insertScore(db, scoreRow(id, { value: score }));
	};
	return { db, add };
}

describe("reviewQueue", () => {
	it("orders failed, over budget, aborted, low score, unscored, then ok", () => {
		const { db, add } = seed();
		add("ok", { status: "succeeded" }, 0.9);
		add("unscored", { status: "succeeded" });
		add("low", { status: "succeeded" }, 0.2);
		add("aborted", { status: "aborted" });
		add("over", { status: "budget_exceeded" });
		add("failed", { status: "failed", error: { code: "PROVIDER_AUTH", message: "x" } as never });
		const items = reviewQueue(db, { now: NOW });
		expect(items.map((i) => i.runId)).toEqual(["failed", "over", "aborted", "low", "unscored", "ok"]);
		expect(items[0]).toMatchObject({ failureMode: "failed", errorCode: "PROVIDER_AUTH" });
		expect(items[3]?.score).toBeCloseTo(0.2);
	});

	it("skips running runs, subagents, old runs and runs with a verdict", () => {
		const { db, add } = seed();
		add("running", { status: "running" });
		add("parent", { status: "failed" });
		add("child", { status: "failed", parentRunId: "parent", rootRunId: "parent" });
		add("old", { status: "failed", startedAt: "2026-09-01T00:00:00.000Z" });
		add("reviewed", { status: "failed" });
		recordFeedback(db, { runId: "reviewed", verdict: "not_done", nowIso: NOW.toISOString(), redact });
		expect(reviewQueue(db, { now: NOW }).map((i) => i.runId)).toEqual(["parent"]);
	});

	it("honours limit (clamped to 1..100) and days", () => {
		const { db, add } = seed();
		for (let i = 0; i < 5; i++) add(`r${i}`, { status: "failed" });
		expect(reviewQueue(db, { now: NOW, limit: 2 })).toHaveLength(2);
		expect(reviewQueue(db, { now: NOW, limit: 0 })).toHaveLength(1);
		expect(reviewQueue(db, { now: NOW, days: 0.01 })).toHaveLength(0);
	});

	it("truncates the instruction to its first line of at most 120 characters", () => {
		const { db, add } = seed();
		add("long", { status: "failed", instruction: `${"a".repeat(300)}\nsecond` });
		const [item] = reviewQueue(db, { now: NOW });
		expect(item?.instruction).toHaveLength(120);
		expect(item?.instruction.endsWith("…")).toBe(true);
	});
});
