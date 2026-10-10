import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor, NexoError, REDACTED } from "@nexo/telemetry";
import { insertRun, latestFeedback, listFeedback, openDb, recordFeedback, reindex, restoreFeedback } from "../src/index.ts";
import { runRow } from "./fixtures.ts";

const redact = createRedactor();
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runWithDir(status: "succeeded" | "running" = "succeeded") {
	const db = openDb(":memory:");
	const root = tempDir("nexo-fb-");
	const row = runRow({ status });
	const dir = join(root, row.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "run.json"), JSON.stringify({ id: row.id, status }));
	insertRun(db, { ...row, dirPath: dir });
	return { db, row, dir, root };
}

function codeOf(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return error instanceof NexoError ? error.code : "not a NexoError";
	}
	return undefined;
}

describe("recordFeedback", () => {
	it("stores a redacted verdict and mirrors the latest into run.json", () => {
		const { db, row, dir } = runWithDir();
		recordFeedback(db, { runId: row.id, verdict: "not_done", comment: "  wrong file sk-ant-abcdefghijklmnopqrstu ", nowIso: "2026-10-11T00:00:00.000Z", redact });
		recordFeedback(db, { runId: row.id, verdict: "done", nowIso: "2026-10-11T00:01:00.000Z", redact });
		expect(listFeedback(db, row.id).map((f) => [f.verdict, f.comment])).toEqual([
			["not_done", `wrong file ${REDACTED}`],
			["done", ""],
		]);
		expect(latestFeedback(db, row.id)?.verdict).toBe("done");
		expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).humanVerdict).toEqual({
			verdict: "done",
			comment: "",
			createdAt: "2026-10-11T00:01:00.000Z",
		});
	});

	it("rejects a bad verdict, a non-string or oversized comment, an unknown run and a running run", () => {
		const { db, row } = runWithDir();
		const base = { runId: row.id, nowIso: "2026-10-11T00:00:00.000Z", redact };
		expect(codeOf(() => recordFeedback(db, { ...base, verdict: "maybe" }))).toBe("INVALID_REQUEST");
		expect(codeOf(() => recordFeedback(db, { ...base, verdict: undefined }))).toBe("INVALID_REQUEST");
		expect(codeOf(() => recordFeedback(db, { ...base, verdict: "done", comment: 42 }))).toBe("INVALID_REQUEST");
		expect(codeOf(() => recordFeedback(db, { ...base, verdict: "done", comment: "x".repeat(10_001) }))).toBe("INVALID_REQUEST");
		expect(codeOf(() => recordFeedback(db, { ...base, runId: "01NOPE", verdict: "done" }))).toBe("NOT_FOUND");
		const running = runWithDir("running");
		expect(codeOf(() => recordFeedback(running.db, { ...base, runId: running.row.id, verdict: "done" }))).toBe("CONFLICT");
		expect(listFeedback(db, row.id)).toEqual([]);
	});

	it("stores feedback when the run directory was deleted", () => {
		const { db, row, dir } = runWithDir();
		rmSync(dir, { recursive: true });
		expect(recordFeedback(db, { runId: row.id, verdict: "done", nowIso: "2026-10-11T00:00:00.000Z", redact }).verdict).toBe("done");
	});

	it("keeps a newer verdict that another process already wrote to run.json", () => {
		const { db, row, dir } = runWithDir();
		const newer = { verdict: "done", comment: "from the other process", createdAt: "2026-10-12T00:00:00.000Z" };
		writeFileSync(join(dir, "run.json"), JSON.stringify({ id: row.id, status: "succeeded", humanVerdict: newer }));
		recordFeedback(db, { runId: row.id, verdict: "not_done", comment: "older", nowIso: "2026-10-11T00:00:00.000Z", redact });
		expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).humanVerdict).toEqual(newer);
		expect(latestFeedback(db, row.id)?.comment).toBe("older");
	});

	it("keeps every verdict from back-to-back submissions and reports the newest", () => {
		const { db, row, dir } = runWithDir();
		for (let i = 0; i < 20; i++) {
			recordFeedback(db, { runId: row.id, verdict: i % 2 ? "done" : "not_done", comment: `#${i}`, nowIso: "2026-10-11T00:00:00.000Z", redact });
		}
		expect(listFeedback(db, row.id)).toHaveLength(20);
		expect(latestFeedback(db, row.id)?.comment).toBe("#19");
		expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).humanVerdict.comment).toBe("#19");
	});

	it("rewrites a corrupt run.json with the verdict", () => {
		const { db, row, dir } = runWithDir();
		writeFileSync(join(dir, "run.json"), "{not json");
		recordFeedback(db, { runId: row.id, verdict: "done", nowIso: "2026-10-11T00:00:00.000Z", redact });
		expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).humanVerdict.verdict).toBe("done");
	});

	it("throws STORE_IO and leaves no tmp file when run.json cannot be written", () => {
		const { db, row, dir } = runWithDir();
		chmodSync(dir, 0o500);
		try {
			expect(codeOf(() => recordFeedback(db, { runId: row.id, verdict: "done", nowIso: "2026-10-11T00:00:00.000Z", redact }))).toBe("STORE_IO");
		} finally {
			chmodSync(dir, 0o700);
		}
		expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});
});

describe("reindex and feedback", () => {
	it("does not restore a humanVerdict without a createdAt", () => {
		const db = openDb(":memory:");
		expect(restoreFeedback(db, "r1", { verdict: "done", comment: "" } as never)).toBe(false);
		expect(listFeedback(db, "r1")).toEqual([]);
	});

	it("keeps feedback rows and restores a verdict from run.json into an empty table", () => {
		const root = tempDir("nexo-fb-reindex-");
		const id = "01J0000000000000000000000A";
		mkdirSync(join(root, id), { recursive: true });
		const runJson = {
			id, parentRunId: null, rootRunId: id, instruction: "x", skill: null, status: "succeeded", model: null,
			startedAt: "2026-10-10T00:00:00.000Z", endedAt: "2026-10-10T00:00:01.000Z", costUsd: 0, costUnknown: false,
			tokensIn: 0, tokensOut: 0, output: "", error: null, artifactSetId: null, configSnapshotHash: "h", workspace: "/w",
			taskGraphs: [], humanVerdict: { verdict: "not_done", comment: "missed a step", createdAt: "2026-10-10T00:00:02.000Z" },
		};
		writeFileSync(join(root, id, "run.json"), JSON.stringify(runJson));
		const db = openDb(":memory:");
		reindex(db, root);
		expect(listFeedback(db, id).map((f) => f.comment)).toEqual(["missed a step"]);
		reindex(db, root);
		expect(listFeedback(db, id)).toHaveLength(1);
	});
});
