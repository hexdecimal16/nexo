import { describe, expect, it } from "vitest";
import { createRedactor, NexoError } from "@nexo/telemetry";
import {
	COST_DIMENSIONS,
	costReport,
	decodeRunCursor,
	descendantRunIds,
	encodeRunCursor,
	insertRun,
	isCostDimension,
	normalizeSince,
	openDb,
	queryRuns,
	recordFeedback,
	type RunPage,
} from "../src/index.ts";
import { runRow } from "./fixtures.ts";

const redact = createRedactor();

function seed(count: number, startedAt = (i: number) => `2026-10-10T00:00:${String(i).padStart(2, "0")}.000Z`) {
	const db = openDb(":memory:");
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const row = runRow({ status: "succeeded", startedAt: startedAt(i) });
		insertRun(db, row);
		ids.push(row.id);
	}
	return { db, ids };
}

function allPages(db: ReturnType<typeof openDb>, limit: number): string[][] {
	const pages: string[][] = [];
	let cursor: string | undefined;
	for (;;) {
		const page: RunPage = queryRuns(db, { limit, cursor });
		pages.push(page.runs.map((r) => r.id));
		if (!page.nextCursor) return pages;
		cursor = page.nextCursor;
	}
}

function codeOf(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return (error as NexoError).code;
	}
	return undefined;
}

describe("queryRuns pagination", () => {
	it("returns an empty page with no cursor for an empty index", () => {
		expect(queryRuns(openDb(":memory:"))).toEqual({ runs: [], nextCursor: null });
	});

	it("gives no next cursor when the last page is exactly full", () => {
		const { db, ids } = seed(4);
		expect(allPages(db, 2)).toEqual([
			[ids[3], ids[2]],
			[ids[1], ids[0]],
		]);
	});

	it("walks runs sharing one started_at without skipping or repeating", () => {
		const { db, ids } = seed(5, () => "2026-10-10T00:00:00.000Z");
		const flat = allPages(db, 2).flat();
		expect(flat).toHaveLength(5);
		expect(new Set(flat)).toEqual(new Set(ids));
		expect(flat).toEqual([...ids].sort().reverse());
	});

	it("does not repeat rows when newer runs arrive between pages", () => {
		const { db, ids } = seed(3);
		const first = queryRuns(db, { limit: 2 });
		insertRun(db, runRow({ status: "succeeded", startedAt: "2026-10-11T00:00:00.000Z" }));
		const second = queryRuns(db, { limit: 2, cursor: first.nextCursor ?? undefined });
		expect(second.runs.map((r) => r.id)).toEqual([ids[0]]);
	});

	it("rejects bad limits, statuses, since values and cursors with INVALID_REQUEST", () => {
		const db = openDb(":memory:");
		for (const limit of [0, -1, 201, 1.5, Number.NaN]) expect(codeOf(() => queryRuns(db, { limit }))).toBe("INVALID_REQUEST");
		expect(codeOf(() => queryRuns(db, { status: "done" as never }))).toBe("INVALID_REQUEST");
		expect(codeOf(() => queryRuns(db, { since: "yesterday" }))).toBe("INVALID_REQUEST");
		expect(codeOf(() => queryRuns(db, { cursor: "garbage" }))).toBe("INVALID_REQUEST");
		expect(codeOf(() => queryRuns(db, { cursor: Buffer.from("[1,2]").toString("base64url") }))).toBe("INVALID_REQUEST");
		expect(decodeRunCursor(encodeRunCursor("2026-10-10T00:00:00.000Z", "abc"))).toEqual({ startedAt: "2026-10-10T00:00:00.000Z", id: "abc" });
	});
});

describe("queryRuns filters", () => {
	it("filters by status, skill, since and reviewed; the review queue excludes running runs", () => {
		const db = openDb(":memory:");
		const reviewed = runRow({ status: "succeeded", skill: "report", startedAt: "2026-10-09T00:00:00.000Z" });
		const pending = runRow({ status: "failed", startedAt: "2026-10-10T00:00:00.000Z" });
		const running = runRow({ status: "running", startedAt: "2026-10-11T00:00:00.000Z" });
		for (const r of [reviewed, pending, running]) insertRun(db, r);
		insertRun(db, runRow({ parentRunId: pending.id, rootRunId: pending.id, status: "succeeded" }));
		recordFeedback(db, { runId: reviewed.id, verdict: "done", nowIso: "2026-10-11T00:00:00.000Z", redact });
		const ids = (q: Parameters<typeof queryRuns>[1]) => queryRuns(db, q).runs.map((r) => r.id);
		expect(ids({ reviewed: true })).toEqual([reviewed.id]);
		expect(ids({ reviewed: false })).toEqual([pending.id]);
		expect(ids({ status: "running" })).toEqual([running.id]);
		expect(ids({ skill: "report" })).toEqual([reviewed.id]);
		expect(ids({ since: "2026-10-10" })).toEqual([running.id, pending.id]);
		const summary = queryRuns(db, {}).runs.find((r) => r.id === pending.id);
		expect(summary).toMatchObject({ childCount: 1, verdict: null });
		expect(queryRuns(db, {}).runs.find((r) => r.id === reviewed.id)?.verdict).toBe("done");
		expect(queryRuns(db, { rootOnly: false }).runs).toHaveLength(4);
	});

	it("truncates long instructions in summaries", () => {
		const db = openDb(":memory:");
		insertRun(db, runRow({ instruction: "x".repeat(2000) }));
		expect(queryRuns(db).runs[0]?.instruction).toHaveLength(501);
	});
});

describe("descendantRunIds", () => {
	it("returns the run and its subagents at every depth", () => {
		const db = openDb(":memory:");
		const root = runRow();
		const child = runRow({ parentRunId: root.id, rootRunId: root.id });
		const grandchild = runRow({ parentRunId: child.id, rootRunId: root.id });
		for (const r of [root, child, grandchild, runRow()]) insertRun(db, r);
		expect(descendantRunIds(db, root.id)).toEqual([root.id, child.id, grandchild.id]);
		expect(descendantRunIds(db, child.id)).toEqual([child.id, grandchild.id]);
		expect(descendantRunIds(db, "missing")).toEqual([]);
	});
});

describe("normalizeSince", () => {
	it("compares minute and second precision correctly against millisecond timestamps", () => {
		const db = openDb(":memory:");
		const inside = runRow({ status: "succeeded", startedAt: "2026-10-10T10:30:05.250Z" });
		insertRun(db, inside);
		insertRun(db, runRow({ status: "succeeded", startedAt: "2026-10-10T10:29:59.999Z" }));
		for (const since of ["2026-10-10T10:30Z", "2026-10-10T10:30:00Z", "2026-10-10T10:30:05Z"]) {
			expect(queryRuns(db, { since }).runs.map((r) => r.id), since).toEqual([inside.id]);
		}
		expect(normalizeSince("2026-10-10")).toBe("2026-10-10T00:00:00.000Z");
		expect(codeOf(() => normalizeSince("2026-02-30"))).toBe("INVALID_REQUEST");
		expect(codeOf(() => normalizeSince("2026-10-10T10:30:00+02:00"))).toBe("INVALID_REQUEST");
	});
});

describe("costReport", () => {
	it("defaults since to 30 days before now, totals the rows and validates its input", () => {
		const db = openDb(":memory:");
		const report = costReport(db, { by: "day", now: new Date("2026-10-11T12:00:00.000Z") });
		expect(report).toEqual({ by: "day", since: "2026-09-11", rows: [], totalUsd: 0, unknownCalls: 0 });
		expect(codeOf(() => costReport(db, { by: "color" }))).toBe("INVALID_REQUEST");
		expect(codeOf(() => costReport(db, { by: "day", since: "2026-02-30" }))).toBe("INVALID_REQUEST");
		expect(codeOf(() => costReport(db, { by: "day", since: "10/10/2026" }))).toBe("INVALID_REQUEST");
		expect(COST_DIMENSIONS.every(isCostDimension)).toBe(true);
	});
});
