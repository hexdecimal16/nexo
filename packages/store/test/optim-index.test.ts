import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "@nexo/telemetry";
import { costReport, getRun, insertRun, insertSpan, openDb, queryRuns, reindex, RunDir } from "../src/index.ts";
import { runRow, spanRow } from "./fixtures.ts";

const redact = createRedactor();
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "nexo-optim-index-"));
	dirs.push(dir);
	return dir;
}

describe("optimization runs in the index", () => {
	it("leaves rollouts and the optimizer run out of run lists and the review queue unless asked for", () => {
		const db = openDb(":memory:");
		const plain = runRow({ status: "succeeded" });
		const rollout = runRow({ status: "succeeded", optimRunId: "01OPTIMRUN0000000000000000" });
		insertRun(db, plain);
		insertRun(db, rollout);
		expect(queryRuns(db).runs.map((r) => r.id)).toEqual([plain.id]);
		expect(queryRuns(db, { reviewed: false }).runs.map((r) => r.id)).toEqual([plain.id]);
		const own = queryRuns(db, { optimRunId: "01OPTIMRUN0000000000000000" }).runs;
		expect(own.map((r) => r.id)).toEqual([rollout.id]);
		expect(own[0]?.optimRunId).toBe("01OPTIMRUN0000000000000000");
		expect(getRun(db, rollout.id)?.optimRunId).toBe("01OPTIMRUN0000000000000000");
	});

	it("groups an optimization's spend under optim:<id> in the cost report by run, reflection calls included", () => {
		const db = openDb(":memory:");
		const optimId = "01OPTIMRUN0000000000000001";
		const rollout = runRow({ status: "succeeded", optimRunId: optimId, startedAt: "2026-10-12T00:00:00.000Z" });
		const optimizer = runRow({ id: optimId, status: "succeeded", optimRunId: optimId, startedAt: "2026-10-12T00:00:00.000Z" });
		const plain = runRow({ status: "succeeded", startedAt: "2026-10-12T00:00:00.000Z" });
		for (const r of [rollout, optimizer, plain]) insertRun(db, r);
		insertSpan(db, spanRow(rollout.id, { costUsd: 0.25, startedAt: "2026-10-12T00:00:01.000Z" }));
		insertSpan(db, spanRow(optimizer.id, { kind: "gepa_call", tier: "gepa", costUsd: 0.5, startedAt: "2026-10-12T00:00:02.000Z" }));
		insertSpan(db, spanRow(plain.id, { costUsd: 0.1, startedAt: "2026-10-12T00:00:03.000Z" }));
		const report = costReport(db, { by: "run", since: "2026-10-01", now: new Date("2026-10-12T12:00:00Z") });
		expect(report.rows).toEqual([
			{ key: `optim:${optimId}`, costUsd: 0.75, calls: 2, unknownCalls: 0 },
			{ key: plain.id, costUsd: 0.1, calls: 1, unknownCalls: 0 },
		]);
		expect(costReport(db, { by: "tier", since: "2026-10-01", now: new Date("2026-10-12T12:00:00Z") }).rows.map((r) => r.key)).toContain("gepa");
	});

	it("reindexes the optimizer run and its rollouts from the optimization directory", () => {
		const home = tempHome();
		const db = openDb(":memory:");
		const optimRoot = join(home, "optim");
		const optimId = "01OPTIMRUN0000000000000002";
		const own = RunDir.create(optimRoot, optimId, redact);
		const rollout = RunDir.create(join(own.root, "rollouts"), "01ROLLOUT00000000000000000", redact);
		const json = (id: string, dir: RunDir) => ({
			id,
			parentRunId: null,
			rootRunId: id,
			instruction: "x",
			skill: null,
			status: "succeeded" as const,
			model: null,
			startedAt: "2026-10-12T00:00:00.000Z",
			endedAt: "2026-10-12T00:00:01.000Z",
			costUsd: 0,
			costUnknown: false,
			tokensIn: 0,
			tokensOut: 0,
			output: "",
			error: null,
			artifactSetId: null,
			configSnapshotHash: "h",
			workspace: dir.workspaceDir,
			taskGraphs: [],
			optimRunId: optimId,
		});
		own.writeRunJson(json(optimId, own));
		rollout.writeRunJson(json("01ROLLOUT00000000000000000", rollout));
		const result = reindex(db, join(home, "runs"), undefined, optimRoot);
		expect(result.runs).toBe(2);
		expect(getRun(db, "01ROLLOUT00000000000000000")?.optimRunId).toBe(optimId);
		expect(getRun(db, optimId)?.dirPath).toBe(own.root);
		expect(queryRuns(db).runs).toEqual([]);
	});
});
