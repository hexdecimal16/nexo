import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	addSpend,
	createArtifactSet,
	dayScope,
	ensureManualArtifact,
	getActiveArtifact,
	getRun,
	getSpent,
	insertRun,
	insertSpan,
	listChildRuns,
	listRuns,
	listSpans,
	monthScope,
	openDb,
	recoverCrashedRuns,
	updateRun,
	updateSpan,
} from "../src/index.ts";
import { runRow as run, spanRow as span } from "./fixtures.ts";

describe("runs", () => {
	it("inserts, updates and reads back with typed fields", () => {
		const db = openDb(":memory:");
		const r = run();
		insertRun(db, r);
		updateRun(db, r.id, {
			status: "failed",
			costUsd: 0.25,
			costUnknown: true,
			error: { code: "PROVIDER_AUTH", message: "no key", retryable: false },
		});
		const got = getRun(db, r.id);
		expect(got).toMatchObject({ status: "failed", costUsd: 0.25, costUnknown: true });
		expect(got?.error?.code).toBe("PROVIDER_AUTH");
	});

	it("lists root runs newest first and children by parent", () => {
		const db = openDb(":memory:");
		const parent = run({ startedAt: "2026-10-10T00:00:00.000Z" });
		const later = run({ startedAt: "2026-10-11T00:00:00.000Z" });
		insertRun(db, parent);
		insertRun(db, later);
		insertRun(db, run({ parentRunId: parent.id, rootRunId: parent.id }));
		expect(listRuns(db, { rootOnly: true }).map((r) => r.id)).toEqual([later.id, parent.id]);
		expect(listChildRuns(db, parent.id)).toHaveLength(1);
	});

	it("recovers crashed runs only for dead pids and rewrites their run.json", () => {
		const db = openDb(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "nexo-crash-"));
		writeFileSync(join(dir, "run.json"), JSON.stringify({ id: "x", status: "running", endedAt: null, error: null }));
		const dead = run({ pid: 111, dirPath: dir });
		const alive = run({ pid: 222 });
		insertRun(db, dead);
		insertRun(db, alive);
		const ids = recoverCrashedRuns(db, (pid) => pid === 222, "2026-10-10T01:00:00.000Z");
		expect(ids).toEqual([dead.id]);
		expect(getRun(db, dead.id)).toMatchObject({ status: "aborted", endedAt: "2026-10-10T01:00:00.000Z", error: { code: "INTERNAL" } });
		expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))).toMatchObject({
			id: "x",
			status: "aborted",
			endedAt: "2026-10-10T01:00:00.000Z",
			error: { code: "INTERNAL" },
		});
		expect(getRun(db, alive.id)?.status).toBe("running");
	});

	it("ends a crashed run's open spans at its last recorded activity", () => {
		const db = openDb(":memory:");
		const dead = run({ pid: 111 });
		insertRun(db, dead);
		insertSpan(db, span(dead.id, { status: "ok", startedAt: "2026-10-10T00:00:01.000Z", endedAt: "2026-10-10T00:00:05.000Z" }));
		const open = span(dead.id, { status: "running", startedAt: "2026-10-10T00:00:06.000Z" });
		insertSpan(db, open);
		recoverCrashedRuns(db, () => false, "2026-10-10T09:00:00.000Z");
		expect(getRun(db, dead.id)).toMatchObject({ status: "aborted", endedAt: "2026-10-10T00:00:06.000Z" });
		const closed = listSpans(db, dead.id).find((s) => s.id === open.id);
		expect(closed).toMatchObject({ status: "error", endedAt: "2026-10-10T00:00:06.000Z" });
		expect(closed?.attrs.interrupted).toBe(1);
	});

	it("leaves running rows without a pid alone", () => {
		const db = openDb(":memory:");
		const noPid = run({ pid: null });
		insertRun(db, noPid);
		expect(recoverCrashedRuns(db, () => false, "2026-10-10T01:00:00.000Z")).toEqual([]);
		expect(getRun(db, noPid.id)?.status).toBe("running");
	});
});

describe("spans", () => {
	it("inserts, updates and lists in start order with attrs JSON", () => {
		const db = openDb(":memory:");
		const r = run();
		insertRun(db, r);
		const a = span(r.id, { startedAt: "2026-10-10T00:00:02.000Z" });
		const b = span(r.id, { startedAt: "2026-10-10T00:00:01.000Z", kind: "tool_call" });
		insertSpan(db, a);
		insertSpan(db, b);
		updateSpan(db, a.id, { status: "ok", costUsd: 0.01, attrs: { stopReason: "stop" } });
		const spans = listSpans(db, r.id);
		expect(spans.map((s) => s.id)).toEqual([b.id, a.id]);
		expect(spans[1]).toMatchObject({ status: "ok", costUsd: 0.01, attrs: { stopReason: "stop" } });
	});
});

describe("budget ledger", () => {
	it("formats UTC scopes and accumulates spend", () => {
		const db = openDb(":memory:");
		const d = new Date("2026-10-10T23:30:00.000Z");
		expect(dayScope(d)).toBe("day:2026-10-10");
		expect(monthScope(d)).toBe("month:2026-10");
		addSpend(db, [dayScope(d), monthScope(d)], 0.1, d.toISOString());
		addSpend(db, [dayScope(d)], 0.05, d.toISOString());
		expect(getSpent(db, dayScope(d))).toBeCloseTo(0.15);
		expect(getSpent(db, monthScope(d))).toBeCloseTo(0.1);
		expect(getSpent(db, "day:1999-01-01")).toBe(0);
	});
});

describe("artifacts", () => {
	it("reuses the active version for identical content and versions changes", () => {
		const db = openDb(":memory:");
		const v1 = ensureManualArtifact(db, "system_prompt", "default", "hello", "t1");
		const again = ensureManualArtifact(db, "system_prompt", "default", "hello", "t2");
		expect(again.id).toBe(v1.id);
		const v2 = ensureManualArtifact(db, "system_prompt", "default", "hello v2", "t3");
		expect(v2.version).toBe(2);
		expect(v2.parentVersionId).toBe(v1.id);
		expect(getActiveArtifact(db, "system_prompt", "default")?.id).toBe(v2.id);
	});

	it("keeps exactly one active version when a second writer acts on a stale view", () => {
		const db = openDb(":memory:");
		ensureManualArtifact(db, "playbook", "p", "one", "t1");
		ensureManualArtifact(db, "playbook", "p", "two", "t2");
		ensureManualArtifact(db, "playbook", "p", "two", "t3");
		const active = db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind='playbook' AND name='p' AND status='active'").get();
		expect(active?.n).toBe(1);
		expect(() =>
			db.prepare("INSERT INTO artifacts VALUES ('dup','playbook','p',9,'x','h',NULL,'manual','active','t')").run(),
		).toThrow();
	});

	it("deduplicates artifact sets by members", () => {
		const db = openDb(":memory:");
		const a = ensureManualArtifact(db, "skill", "x", "body", "t");
		const members = [{ kind: a.kind, name: a.name, artifactId: a.id, version: a.version }];
		expect(createArtifactSet(db, members, "t")).toBe(createArtifactSet(db, members, "t2"));
	});
});
