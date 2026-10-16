import { describe, expect, it } from "vitest";
import { createRedactor } from "@nexo/telemetry";
import { addEvalCase, insertMinedCases, insertRun, listEvalCases, mineCandidateRuns, openDb, parseOptimTarget, proposeClusters, recordFeedback } from "../src/index.ts";
import { runRow } from "./fixtures.ts";

const redact = createRedactor();
const NOW = "2026-10-16T00:00:00.000Z";
const same = (a: string, b: string) => a.split(" ")[0] === b.split(" ")[0];
const never = () => false;

describe("proposeClusters", () => {
	it("returns nothing for empty input or clusters under minCluster", () => {
		expect(proposeClusters<string>([], { similar: same, nearExisting: never, minCluster: 2, maxNew: 3 })).toEqual([]);
		expect(proposeClusters(["a 1", "b 1", "c 1"], { similar: same, nearExisting: never, minCluster: 2, maxNew: 3 })).toEqual([]);
	});

	it("joins each item to the first cluster whose leader it resembles, newest item leading", () => {
		const items = ["fix 3", "deploy 2", "fix 2", "fix 1", "deploy 1"];
		expect(proposeClusters(items, { similar: same, nearExisting: never, minCluster: 2, maxNew: 3 })).toEqual([
			["fix 3", "fix 2", "fix 1"],
			["deploy 2", "deploy 1"],
		]);
	});

	it("puts identical items in one cluster", () => {
		expect(proposeClusters(["x", "x", "x"], { similar: (a, b) => a === b, nearExisting: never, minCluster: 3, maxNew: 3 })).toEqual([["x", "x", "x"]]);
	});

	it("drops clusters near an existing case and caps the result at maxNew, biggest first", () => {
		const items = ["a 1", "b 1", "c 1", "a 2", "b 2", "c 2", "c 3", "d 1", "d 2"];
		const out = proposeClusters(items, { similar: same, nearExisting: (leader) => leader.startsWith("d"), minCluster: 2, maxNew: 2 });
		expect(out.map((c) => c[0])).toEqual(["c 1", "a 1"]);
	});
});

describe("mineCandidateRuns and insertMinedCases", () => {
	it("mines only recent, unreviewed, uncased root runs of the target, newest first, and stores proposed cases", () => {
		const db = openDb(":memory:");
		const run = (id: string, startedAt: string, extra: Partial<ReturnType<typeof runRow>> = {}) =>
			insertRun(db, runRow({ id, status: "succeeded", skill: "ci-fix", instruction: `Fix CI ${id}`, startedAt, endedAt: startedAt, ...extra }));
		run("OLD", "2026-08-01T00:00:00.000Z");
		run("R1", "2026-10-10T00:00:00.000Z");
		run("R2", "2026-10-11T00:00:00.000Z");
		run("REVIEWED", "2026-10-12T00:00:00.000Z");
		recordFeedback(db, { runId: "REVIEWED", verdict: "done", comment: "", nowIso: NOW, redact });
		run("OTHER", "2026-10-12T00:00:00.000Z", { skill: "deploy" });
		run("CHILD", "2026-10-12T00:00:00.000Z", { parentRunId: "R1", rootRunId: "R1" });
		run("LIVE", "2026-10-12T00:00:00.000Z", { status: "running", endedAt: null });
		run("CASED", "2026-10-13T00:00:00.000Z");
		db.prepare("INSERT INTO eval_cases (id, target, source_run_id, input, split, created_at, origin) VALUES ('X', 'skill:ci-fix', 'CASED', 'x', 'pareto', ?, 'run')").run(NOW);
		const target = parseOptimTarget("skill:ci-fix");
		const items = mineCandidateRuns(db, target, { sinceIso: "2026-10-01T00:00:00.000Z", maxRuns: 500 });
		expect(items.map((i) => i.runId)).toEqual(["R2", "R1"]);
		expect(mineCandidateRuns(db, target, { sinceIso: "2026-10-01T00:00:00.000Z", maxRuns: 1 }).map((i) => i.runId)).toEqual(["R2"]);

		const [added] = insertMinedCases(db, target, [items], redact, NOW);
		expect(added).toMatchObject({ origin: "mined", status: "proposed", sourceRunId: "R2", input: "Fix CI R2", skill: "ci-fix", expected: null, minedFrom: ["R2", "R1"] });
		// Mining again proposes nothing new: the leader is now a case.
		expect(mineCandidateRuns(db, target, { sinceIso: "2026-10-01T00:00:00.000Z", maxRuns: 500 }).map((i) => i.runId)).toEqual(["R1"]);
	});

	it("redacts and clips a mined instruction", () => {
		const db = openDb(":memory:");
		const secret = `sk-ant-api03-${"b".repeat(40)} ${"y".repeat(25_000)}`;
		const [c] = insertMinedCases(db, parseOptimTarget("system_prompt"), [[{ runId: "R1", instruction: secret, skill: null, startedAt: NOW }]], redact, NOW);
		expect(c!.input).not.toContain("sk-ant-api03");
		expect(c!.input.length).toBe(20_000);
	});

	it("does not touch existing cases", () => {
		const db = openDb(":memory:");
		addEvalCase(db, { target: "skill:ci-fix", input: "a" }, redact, NOW);
		insertMinedCases(db, parseOptimTarget("skill:ci-fix"), [], redact, NOW);
		expect(listEvalCases(db, "skill:ci-fix")).toHaveLength(1);
	});
});
