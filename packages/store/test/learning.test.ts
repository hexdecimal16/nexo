import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "@nexo/telemetry";
import {
	addMemory,
	addPlaybookItem,
	claimLearnJob,
	completeLearnJob,
	costReport,
	decodeVector,
	encodeVector,
	enqueueLearnJob,
	failLearnJob,
	ftsQuery,
	ftsScores,
	getActiveArtifact,
	getEmbeddings,
	getLearnJob,
	getMemory,
	insertRun,
	insertSpan,
	listArtifactVersions,
	listLearnJobs,
	latestFeedback,
	listMemories,
	MAX_LEARN_ATTEMPTS,
	listPlaybookItems,
	MAX_ACE_IMPORTANCE,
	memoriesWithoutEmbedding,
	memoryHistory,
	openDb,
	playbookItemHistory,
	prunePlaybook,
	publishPlaybook,
	putEmbedding,
	reclaimStaleLearnJobs,
	recordFeedback,
	releaseLearnJob,
	retireMemory,
	retirePlaybookItem,
	retryFailedLearnJobs,
	supersedeMemory,
	tagPlaybookItem,
	transaction,
	updatePlaybookItem,
} from "../src/index.ts";
import { runRow, spanRow } from "./fixtures.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const redact = createRedactor();
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("memories", () => {
	it("stores redacted memories and clamps curator importance to 0.7", () => {
		const db = openDb(":memory:");
		const ace = addMemory(db, { scope: "user", type: "fact", content: "  key sk-ant-abcdefghijklmnopqrstuv works ", importance: 0.95, source: "ace" }, redact, NOW);
		const human = addMemory(db, { scope: "skill:deploy", type: "lesson", content: "Run tests first", importance: 1, source: "human" }, redact, NOW);
		expect(ace.content).toBe("key [REDACTED] works");
		expect(ace.importance).toBe(MAX_ACE_IMPORTANCE);
		expect(getMemory(db, human.id)?.importance).toBe(1);
	});

	it("rejects bad scopes, types, empty or oversized content and out-of-range importance", () => {
		const db = openDb(":memory:");
		const base = { scope: "user", type: "fact" as const, content: "x", importance: 0.5, source: "user" as const };
		for (const bad of [{ scope: "skill:" }, { scope: "skill:Bad Name" }, { scope: "team" }, { type: "rule" }, { content: "  " }, { content: "x".repeat(1001) }, { importance: 1.5 }, { importance: Number.NaN }]) {
			expect(() => addMemory(db, { ...base, ...bad } as never, redact, NOW)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
		}
	});

	it("supersedes without deleting and keeps the history chain", () => {
		const db = openDb(":memory:");
		const a = addMemory(db, { scope: "user", type: "preference", content: "Tabs", importance: 0.5, source: "ace" }, redact, NOW);
		const b = supersedeMemory(db, a.id, { content: "Two spaces" }, "ace", redact, NOW);
		expect(getMemory(db, a.id)?.supersededBy).toBe(b.id);
		expect(listMemories(db).map((m) => m.content)).toEqual(["Two spaces"]);
		expect(listMemories(db, { includeInactive: true })).toHaveLength(2);
		expect(memoryHistory(db, b.id).map((m) => m.content)).toEqual(["Tabs"]);
		expect(() => supersedeMemory(db, a.id, { content: "again" }, "ace", redact, NOW)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
	});

	it("refuses the curator superseding or retiring a human or user memory, and lets the user do it", () => {
		const db = openDb(":memory:");
		const human = addMemory(db, { scope: "user", type: "lesson", content: "Never push to main", importance: 1, source: "human" }, redact, NOW);
		const user = addMemory(db, { scope: "global", type: "fact", content: "Prod is eu-west-1", importance: 0.8, source: "user" }, redact, NOW);
		for (const m of [human, user]) {
			expect(() => supersedeMemory(db, m.id, { content: "overwritten" }, "ace", redact, NOW)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
			expect(() => retireMemory(db, m.id, "ace", NOW)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
		}
		expect(listMemories(db)).toHaveLength(2);
		expect(retireMemory(db, human.id, "user", NOW).retiredAt).toBe(NOW);
		expect(listMemories(db).map((m) => m.id)).toEqual([user.id]);
		expect(() => retireMemory(db, "nope", "user", NOW)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
	});

	it("filters by scope and type and validates the filter", () => {
		const db = openDb(":memory:");
		addMemory(db, { scope: "user", type: "fact", content: "a", importance: 0.5, source: "user" }, redact, NOW);
		addMemory(db, { scope: "skill:x", type: "lesson", content: "b", importance: 0.5, source: "user" }, redact, NOW);
		expect(listMemories(db, { scope: "skill:x" }).map((m) => m.content)).toEqual(["b"]);
		expect(listMemories(db, { type: "fact" }).map((m) => m.content)).toEqual(["a"]);
		expect(() => listMemories(db, { scope: "nope" })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
		expect(() => listMemories(db, { type: "nope" })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
	});

	it("scores live memories with FTS5 BM25 and treats query text as words, never as FTS syntax", () => {
		const db = openDb(":memory:");
		const a = addMemory(db, { scope: "user", type: "fact", content: "The repo uses pnpm workspaces", importance: 0.5, source: "user" }, redact, NOW);
		const b = addMemory(db, { scope: "user", type: "fact", content: "Deploys run on Fridays", importance: 0.5, source: "user" }, redact, NOW);
		addMemory(db, { scope: "skill:other", type: "fact", content: "pnpm is banned here", importance: 0.5, source: "user" }, redact, NOW);
		const retired = addMemory(db, { scope: "user", type: "fact", content: "pnpm old note", importance: 0.5, source: "user" }, redact, NOW);
		retireMemory(db, retired.id, "user", NOW);
		const scores = ftsScores(db, "Install deps with pnpm", ["user", "global"]);
		expect([...scores.keys()]).toEqual([a.id]);
		expect(scores.get(a.id)).toBeGreaterThan(0);
		expect(ftsQuery('NEAR(a b) "x" OR AND* -y')).toBe('"near"');
		expect(ftsQuery("How do I deploy with the CLI?")).toBe('"deploy" OR "cli"');
		expect(() => ftsScores(db, 'pnpm" OR content:* NEAR(', ["user"])).not.toThrow();
		expect(ftsScores(db, "!!! ?", ["user"]).size).toBe(0);
		expect(ftsScores(db, "deploys", []).size).toBe(0);
		expect(ftsScores(db, "deploy", ["user"]).has(b.id)).toBe(true);
	});

	it("round-trips float32 embeddings and lists memories missing one for a model", () => {
		const db = openDb(":memory:");
		const a = addMemory(db, { scope: "user", type: "fact", content: "a", importance: 0.5, source: "user" }, redact, NOW);
		const b = addMemory(db, { scope: "user", type: "fact", content: "b", importance: 0.5, source: "user" }, redact, NOW);
		expect([...decodeVector(encodeVector([0.5, -1, 3.25]))]).toEqual([0.5, -1, 3.25]);
		putEmbedding(db, a.id, "openai/e3", [0.6, 0.8], NOW);
		expect([...(getEmbeddings(db, [a.id, b.id], "openai/e3").get(a.id) ?? [])]).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6)]);
		expect(getEmbeddings(db, [a.id], "other/model").size).toBe(0);
		expect(memoriesWithoutEmbedding(db, "openai/e3", 10).map((m) => m.id)).toEqual([b.id]);
		expect(() => putEmbedding(db, b.id, "openai/e3", [], NOW)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
	});

	it("nests transactions with savepoints and rolls back only the inner one", () => {
		const db = openDb(":memory:");
		transaction(db, () => {
			addMemory(db, { scope: "user", type: "fact", content: "outer", importance: 0.5, source: "user" }, redact, NOW);
			expect(() =>
				transaction(db, () => {
					addMemory(db, { scope: "user", type: "fact", content: "inner", importance: 0.5, source: "user" }, redact, NOW);
					throw new Error("boom");
				}),
			).toThrow("boom");
		});
		expect(listMemories(db).map((m) => m.content)).toEqual(["outer"]);
	});
});

describe("playbook items", () => {
	it("adds keyed items, updates, tags and retires them with history", () => {
		const db = openDb(":memory:");
		const a = addPlaybookItem(db, { skill: "deploy", content: "Check CI first", source: "ace", runId: "r1" }, redact, NOW);
		const b = addPlaybookItem(db, { skill: "deploy", content: "Tag releases", source: "ace" }, redact, NOW);
		expect([a.key, b.key]).toEqual(["k001", "k002"]);
		updatePlaybookItem(db, "deploy", "k001", "Check CI and lint first", "ace", redact, NOW, "r2");
		expect(tagPlaybookItem(db, "deploy", "k001", "helpful", "r3", NOW)).toBe(true);
		expect(tagPlaybookItem(db, "deploy", "k999", "harmful", "r3", NOW)).toBe(false);
		retirePlaybookItem(db, "deploy", "k002", "ace", NOW);
		expect(listPlaybookItems(db, "deploy").map((i) => [i.key, i.content, i.helpful])).toEqual([["k001", "Check CI and lint first", 1]]);
		expect(playbookItemHistory(db, a.id).map((h) => h.action)).toEqual(["add", "update", "helpful"]);
		expect(addPlaybookItem(db, { skill: "deploy", content: "Third", source: "ace" }, redact, NOW).key).toBe("k003");
		expect(() => addPlaybookItem(db, { skill: "Deploy!", content: "x", source: "ace" }, redact, NOW)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
		expect(() => addPlaybookItem(db, { skill: "deploy", content: "x".repeat(501), source: "ace" }, redact, NOW)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
	});

	it("refuses the curator updating or retiring a human item; the user can retire it", () => {
		const db = openDb(":memory:");
		addPlaybookItem(db, { skill: "deploy", content: "Ask before force-pushing", source: "human" }, redact, NOW);
		expect(() => updatePlaybookItem(db, "deploy", "k001", "Force-push freely", "ace", redact, NOW)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
		expect(() => retirePlaybookItem(db, "deploy", "k001", "ace", NOW)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
		expect(listPlaybookItems(db, "deploy")[0]?.content).toBe("Ask before force-pushing");
		expect(retirePlaybookItem(db, "deploy", "k001", "user", NOW).status).toBe("retired");
		expect(() => retirePlaybookItem(db, "deploy", "k001", "user", NOW)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
		expect(() => retirePlaybookItem(db, "deploy", "k404", "user", NOW)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
	});

	it("prunes the lowest (helpful+1)/(harmful+1) curator items and never a human item", () => {
		const db = openDb(":memory:");
		addPlaybookItem(db, { skill: "s", content: "human rule", source: "human" }, redact, NOW);
		addPlaybookItem(db, { skill: "s", content: "good", source: "ace" }, redact, NOW);
		addPlaybookItem(db, { skill: "s", content: "bad", source: "ace" }, redact, NOW);
		addPlaybookItem(db, { skill: "s", content: "neutral", source: "ace" }, redact, NOW);
		tagPlaybookItem(db, "s", "k002", "helpful", null, NOW);
		tagPlaybookItem(db, "s", "k003", "harmful", null, NOW);
		tagPlaybookItem(db, "s", "k001", "harmful", null, NOW);
		tagPlaybookItem(db, "s", "k001", "harmful", null, NOW);
		expect(prunePlaybook(db, "s", 2, NOW)).toEqual(["k003", "k004"]);
		expect(listPlaybookItems(db, "s").map((i) => i.key)).toEqual(["k001", "k002"]);
		expect(prunePlaybook(db, "s", 0, NOW)).toEqual(["k002"]);
		expect(listPlaybookItems(db, "s").map((i) => i.key)).toEqual(["k001"]);
	});

	it("publishes a new ace playbook artifact version only when the rendered text changes", () => {
		const db = openDb(":memory:");
		expect(publishPlaybook(db, "s", "ace", NOW)).toBeUndefined();
		addPlaybookItem(db, { skill: "s", content: "one", source: "ace" }, redact, NOW);
		const v1 = publishPlaybook(db, "s", "ace", NOW);
		expect(v1).toMatchObject({ version: 1, origin: "ace", content: "- [k001] one" });
		tagPlaybookItem(db, "s", "k001", "helpful", null, NOW);
		expect(publishPlaybook(db, "s", "ace", NOW)?.id).toBe(v1?.id);
		retirePlaybookItem(db, "s", "k001", "user", NOW);
		expect(publishPlaybook(db, "s", "manual", NOW)).toMatchObject({ version: 2, origin: "manual", content: "" });
		expect(getActiveArtifact(db, "playbook", "s")?.version).toBe(2);
		expect(listArtifactVersions(db, "playbook", "s").map((a) => [a.version, a.status])).toEqual([
			[2, "active"],
			[1, "retired"],
		]);
	});
});

describe("learn jobs", () => {
	it("keeps one pending job per run and lets a running job's run get a new one", () => {
		const db = openDb(":memory:");
		expect(enqueueLearnJob(db, { runId: "r1", trigger: "run_end" }, NOW)).toMatchObject({ status: "pending", trigger: "run_end", attempts: 0 });
		expect(enqueueLearnJob(db, { runId: "r1", trigger: "feedback" }, NOW)).toBeNull();
		const job = claimLearnJob(db, "w1", NOW);
		expect(job).toMatchObject({ runId: "r1", status: "running", attempts: 1, claimedBy: "w1" });
		expect(enqueueLearnJob(db, { runId: "r1", trigger: "feedback" }, NOW)).toMatchObject({ trigger: "feedback" });
		expect(claimLearnJob(db, "w1", NOW)?.trigger).toBe("feedback");
		expect(claimLearnJob(db, "w1", NOW)).toBeUndefined();
	});

	it("never hands one job to two processes sharing the database file", () => {
		const dir = mkdtempSync(join(tmpdir(), "nexo-learn-"));
		dirs.push(dir);
		const a = openDb(join(dir, "nexo.db"));
		const b = openDb(join(dir, "nexo.db"));
		for (let i = 0; i < 20; i++) enqueueLearnJob(a, { runId: `r${i}`, trigger: "run_end" }, NOW);
		const taken: string[] = [];
		for (let i = 0; i < 30; i++) {
			const job = claimLearnJob(i % 2 ? a : b, i % 2 ? "ui" : "tui", NOW);
			if (job) taken.push(job.id);
		}
		expect(taken).toHaveLength(20);
		expect(new Set(taken).size).toBe(20);
		a.close();
		b.close();
	});

	it("completes, fails and releases only jobs the worker still holds", () => {
		const db = openDb(":memory:");
		enqueueLearnJob(db, { runId: "r1", trigger: "run_end" }, NOW);
		const job = claimLearnJob(db, "w1", NOW);
		if (!job) throw new Error("no job");
		expect(completeLearnJob(db, job.id, "w2", NOW)).toBe(false);
		expect(failLearnJob(db, job.id, "w1", { code: "SCORER_FAILED", message: "bad json", retryable: false }, NOW)).toBe(true);
		expect(getLearnJob(db, job.id)).toMatchObject({ status: "failed", lastError: { code: "SCORER_FAILED" } });
		expect(retryFailedLearnJobs(db, NOW)).toBe(1);
		const again = claimLearnJob(db, "w1", NOW);
		expect(again?.attempts).toBe(2);
		expect(releaseLearnJob(db, job.id, "w1", NOW)).toBe(true);
		expect(getLearnJob(db, job.id)).toMatchObject({ status: "pending", attempts: 1, claimedBy: null });
	});

	it("stops retrying after three attempts", () => {
		const db = openDb(":memory:");
		enqueueLearnJob(db, { runId: "r1", trigger: "run_end" }, NOW);
		for (let i = 0; i < 3; i++) {
			const job = claimLearnJob(db, "w", NOW);
			if (!job) throw new Error("no job");
			failLearnJob(db, job.id, "w", { code: "BUDGET_EXCEEDED", message: "daily", retryable: true }, NOW);
			retryFailedLearnJobs(db, NOW);
		}
		expect(listLearnJobs(db, { status: "failed" })).toEqual([expect.objectContaining({ attempts: 3 })]);
		expect(claimLearnJob(db, "w", NOW)).toBeUndefined();
	});

	it("reclaims jobs left running by a crashed process, failing those out of attempts", () => {
		const db = openDb(":memory:");
		enqueueLearnJob(db, { runId: "r1", trigger: "run_end" }, NOW);
		enqueueLearnJob(db, { runId: "r2", trigger: "run_end" }, NOW);
		const first = claimLearnJob(db, "dead", "2026-10-12T00:00:00.000Z");
		db.prepare("UPDATE learn_jobs SET attempts = 3 WHERE id = ?").run(first?.id ?? "");
		const second = claimLearnJob(db, "dead", "2026-10-12T00:00:00.000Z");
		const fresh = (enqueueLearnJob(db, { runId: "r3", trigger: "run_end" }, NOW), claimLearnJob(db, "alive", "2026-10-12T00:30:00.000Z"));
		const result = reclaimStaleLearnJobs(db, "2026-10-12T00:20:00.000Z", "2026-10-12T00:30:00.000Z");
		expect(result).toEqual({ pending: [second?.id], failed: [first?.id] });
		expect(getLearnJob(db, fresh?.id ?? "")?.status).toBe("running");
		expect(() => listLearnJobs(db, { status: "nope" })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
	});

	it("fails a stale job whose run already has a newer pending job, out of attempts so --retry cannot run it twice", () => {
		const db = openDb(":memory:");
		enqueueLearnJob(db, { runId: "r1", trigger: "run_end" }, NOW);
		const stale = claimLearnJob(db, "dead", "2026-10-12T00:00:00.000Z");
		const newer = enqueueLearnJob(db, { runId: "r1", trigger: "feedback" }, NOW);
		const result = reclaimStaleLearnJobs(db, "2026-10-12T00:20:00.000Z", "2026-10-12T00:30:00.000Z");
		expect(result).toEqual({ pending: [], failed: [stale?.id] });
		expect(getLearnJob(db, stale?.id ?? "")).toMatchObject({ status: "failed", attempts: MAX_LEARN_ATTEMPTS });
		expect(retryFailedLearnJobs(db, NOW)).toBe(0);
		expect(getLearnJob(db, newer?.id ?? "")?.status).toBe("pending");
	});
});

describe("feedback with learning", () => {
	it("stores a not_done comment as a human lesson once and enqueues a reflect job", () => {
		const db = openDb(":memory:");
		const run = runRow({ status: "succeeded", skill: "deploy", instruction: "Ship v2\nwith notes" });
		insertRun(db, run);
		const input = { runId: run.id, verdict: "not_done", comment: "You skipped the changelog", nowIso: NOW, redact, learn: true };
		recordFeedback(db, input);
		recordFeedback(db, input);
		expect(listMemories(db)).toEqual([
			expect.objectContaining({ scope: "skill:deploy", type: "lesson", source: "human", importance: 1, sourceRunId: run.id, content: 'The user marked "Ship v2" not done: You skipped the changelog' }),
		]);
		expect(listLearnJobs(db, { runId: run.id })).toEqual([expect.objectContaining({ trigger: "feedback", status: "pending" })]);
	});

	it("stores the verdict, the human lesson and the job together or not at all", () => {
		const db = openDb(":memory:");
		const run = runRow({ status: "succeeded" });
		insertRun(db, run);
		db.exec("CREATE TRIGGER no_jobs BEFORE INSERT ON learn_jobs BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
		expect(() => recordFeedback(db, { runId: run.id, verdict: "not_done", comment: "wrong file", nowIso: NOW, redact, learn: true })).toThrow("disk I/O error");
		expect(latestFeedback(db, run.id)).toBeUndefined();
		expect(listMemories(db)).toEqual([]);
	});

	it("writes no lesson for done, an empty comment or learning off", () => {
		const db = openDb(":memory:");
		const run = runRow({ status: "succeeded" });
		insertRun(db, run);
		recordFeedback(db, { runId: run.id, verdict: "done", comment: "great", nowIso: NOW, redact, learn: true });
		recordFeedback(db, { runId: run.id, verdict: "not_done", comment: "", nowIso: NOW, redact, learn: true });
		const other = runRow({ status: "succeeded" });
		insertRun(db, other);
		recordFeedback(db, { runId: other.id, verdict: "not_done", comment: "bad", nowIso: NOW, redact });
		expect(listMemories(db)).toEqual([]);
		expect(listLearnJobs(db, { runId: other.id })).toEqual([]);
	});
});

describe("learning cost", () => {
	it("counts reflector, curator and embedding calls in the cost report by tier", () => {
		const db = openDb(":memory:");
		const run = runRow({ status: "succeeded" });
		insertRun(db, run);
		insertSpan(db, spanRow(run.id, { kind: "learn_call", tier: "reflector", costUsd: 0.002, startedAt: "2026-10-11T00:00:00.000Z" }));
		insertSpan(db, spanRow(run.id, { kind: "embedding_call", tier: "embedding", costUsd: 0.0001, costUnknown: true, startedAt: "2026-10-11T00:00:00.000Z" }));
		insertSpan(db, spanRow(run.id, { kind: "learn", tier: null, costUsd: 0, startedAt: "2026-10-11T00:00:00.000Z" }));
		const report = costReport(db, { by: "tier", since: "2026-10-01", now: new Date(NOW) });
		expect(report.rows.map((r) => [r.key, r.calls, r.unknownCalls])).toEqual([
			["reflector", 1, 0],
			["embedding", 1, 1],
		]);
	});
});
