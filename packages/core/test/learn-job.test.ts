import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	addMemory,
	addSpend,
	costReport,
	dayScope,
	getActiveArtifact,
	getEmbeddings,
	getLearnJob,
	getRun,
	getSpent,
	listMemories,
	listPlaybookItems,
	listSpans,
	recordFeedback,
} from "@nexo/store";
import { LearnWorker } from "../src/index.ts";
import { skillMd } from "./scoring-helpers.ts";
import { delta, embeddingServer, finishedRun, lesson, makeEnv, queueJob, reflection, script } from "./learn-helpers.ts";

describe("reflect job", () => {
	it("turns a reviewed run into an ace memory, records charged spans on the run and leaves the run unchanged", async () => {
		const env = makeEnv();
		const s = script(env, [
			"I fixed the build.",
			reflection([lesson("Run the linter before the tests", { importance: 0.95 })]),
			delta([{ op: "add", type: "lesson", scope: "user", content: "Run the linter before the tests", importance: 0.95 }]),
		]);
		const { result, learnEnv } = await finishedRun(env);
		const runId = result.trajectoryId as string;
		const before = getRun(env.deps.db, runId);
		recordFeedback(env.deps.db, { runId, verdict: "not_done", comment: "lint still fails", nowIso: new Date().toISOString(), redact: env.deps.redact });
		const job = queueJob(env, runId, "feedback");
		const outcome = await new LearnWorker(learnEnv).drain();

		expect(outcome).toEqual({ succeeded: 1, failed: 0, released: 0 });
		expect(getLearnJob(env.deps.db, job.id)).toMatchObject({ status: "succeeded", attempts: 1, lastError: null });
		expect(s.prompts[1]).toContain("<<<nexo:data:human_verdict>>>\nnot_done: lint still fails");
		expect(s.prompts[2]).toContain("<<<nexo:data:lessons>>>");
		expect(listMemories(env.deps.db)).toEqual([expect.objectContaining({ source: "ace", importance: 0.7, content: "Run the linter before the tests", sourceRunId: runId })]);
		const spans = listSpans(env.deps.db, runId);
		const learn = spans.filter((sp) => ["learn", "learn_call", "memory_write"].includes(sp.kind));
		expect(learn.map((sp) => [sp.kind, sp.tier, sp.status])).toEqual([
			["learn", null, "ok"],
			["learn_call", "reflector", "ok"],
			["learn_call", "curator", "ok"],
			["memory_write", null, "ok"],
		]);
		const learnCost = learn.reduce((sum, sp) => sum + sp.costUsd, 0);
		expect(learnCost).toBeGreaterThan(0);
		expect(getRun(env.deps.db, runId)).toEqual(before);
		expect(getSpent(env.deps.db, dayScope(new Date()))).toBeCloseTo(result.costUsd + learnCost, 10);
		expect(getSpent(env.deps.db, `run:${runId}`)).toBeCloseTo(result.costUsd, 10);
		expect(costReport(env.deps.db, { by: "tier" }).rows.map((r) => r.key).sort()).toEqual(["curator", "reflector", "s1"]);
		const trajectory = readFileSync(join(result.runDir as string, "trajectory.jsonl"), "utf8");
		expect(trajectory).toContain('"kind":"learn_call"');
	});

	it("fails the job with SCORER_FAILED after a repair and writes nothing; the run stays succeeded", async () => {
		const env = makeEnv();
		script(env, ["Done.", "I think it went fine.", '{"lessons": "many"}']);
		const { result, learnEnv } = await finishedRun(env);
		const job = queueJob(env, result.trajectoryId as string, "run_end");
		expect(await new LearnWorker(learnEnv).drain()).toEqual({ succeeded: 0, failed: 1, released: 0 });
		expect(getLearnJob(env.deps.db, job.id)).toMatchObject({ status: "failed", lastError: { code: "SCORER_FAILED" } });
		expect(listMemories(env.deps.db)).toEqual([]);
		expect(getRun(env.deps.db, result.trajectoryId as string)?.status).toBe("succeeded");
		const spans = listSpans(env.deps.db, result.trajectoryId as string);
		expect(spans.filter((sp) => sp.kind === "learn_call").map((sp) => sp.name)).toEqual(["reflector fast", "reflector-repair fast"]);
		expect(spans.find((sp) => sp.kind === "learn")?.status).toBe("error");
	});

	it("accepts a reply that the repair request fixes, and skips the curator when there is nothing to learn", async () => {
		const env = makeEnv();
		const s = script(env, ["Done.", "no json here", reflection()]);
		const { result, learnEnv } = await finishedRun(env);
		queueJob(env, result.trajectoryId as string, "run_end");
		expect(await new LearnWorker(learnEnv).drain()).toEqual({ succeeded: 1, failed: 0, released: 0 });
		expect(s.calls()).toBe(3);
		expect(s.prompts[2]).toContain("Your previous reply was not valid");
	});

	it("fails with retryable BUDGET_EXCEEDED and calls no model when the daily budget is spent", async () => {
		const env = makeEnv({ config: { budgets: { dailyUsd: 1 } } });
		const s = script(env, ["Done."]);
		const { result, learnEnv } = await finishedRun(env);
		addSpend(env.deps.db, [dayScope(new Date())], 5, new Date().toISOString());
		const job = queueJob(env, result.trajectoryId as string, "run_end");
		await new LearnWorker(learnEnv).drain();
		expect(getLearnJob(env.deps.db, job.id)).toMatchObject({ status: "failed", lastError: { code: "BUDGET_EXCEEDED", retryable: true } });
		expect(s.calls()).toBe(1);
	});

	it("refuses a call whose estimate exceeds learning.perJobUsd", async () => {
		const env = makeEnv({ config: { learning: { perJobUsd: 0.000001 } } });
		const s = script(env, ["Done."]);
		const { result, learnEnv } = await finishedRun(env);
		const job = queueJob(env, result.trajectoryId as string, "run_end");
		await new LearnWorker(learnEnv).drain();
		expect(getLearnJob(env.deps.db, job.id)?.lastError).toMatchObject({ code: "BUDGET_EXCEEDED", message: expect.stringContaining("reflector") });
		expect(s.calls()).toBe(1);
	});

	it("rejects the curator superseding a human lesson and applies the rest", async () => {
		const env = makeEnv();
		const human = addMemory(env.deps.db, { scope: "user", type: "lesson", content: "Never deploy on Fridays", importance: 1, source: "human" }, env.deps.redact, new Date().toISOString());
		script(env, [
			"Done.",
			reflection([lesson("Deploying on Fridays worked fine")]),
			delta([
				{ op: "supersede", id: human.id, content: "Deploy any day" },
				{ op: "add", type: "fact", scope: "user", content: "Friday deploys need a second reviewer", importance: 0.5 },
			]),
		]);
		const { result, learnEnv } = await finishedRun(env);
		queueJob(env, result.trajectoryId as string, "run_end");
		expect((await new LearnWorker(learnEnv).drain()).succeeded).toBe(1);
		expect(listMemories(env.deps.db).map((m) => m.content).sort()).toEqual(["Friday deploys need a second reviewer", "Never deploy on Fridays"]);
		const write = listSpans(env.deps.db, result.trajectoryId as string).find((sp) => sp.kind === "memory_write");
		expect(write?.attrs.result).toMatchObject({ rejected: [{ list: "memory", index: 0, code: "FORBIDDEN" }] });
	});

	it("tags and adds playbook items for a skill the run used and publishes an ace version", async () => {
		const env = makeEnv({ skills: { ci: skillMd("ci", {}) } });
		script(env, [
			"Done.",
			reflection([lesson("Cache dependencies between CI steps", { scope: "skill", skill: "ci" })]),
			delta([], [{ op: "add", skill: "ci", content: "Cache dependencies between steps" }, { op: "add", skill: "other", content: "x" }]),
		]);
		const { result, learnEnv } = await finishedRun(env, { instruction: "Speed up CI", skill: "ci" });
		queueJob(env, result.trajectoryId as string, "run_end");
		await new LearnWorker(learnEnv).drain();
		expect(listPlaybookItems(env.deps.db, "ci").map((i) => [i.key, i.source, i.content])).toEqual([["k001", "ace", "Cache dependencies between steps"]]);
		expect(getActiveArtifact(env.deps.db, "playbook", "ci")).toMatchObject({ origin: "ace", version: 1 });
	});

	it("backfills and stores embeddings through the configured endpoint, charged as embedding_call spans", async () => {
		const server = await embeddingServer();
		try {
			const env = makeEnv({ config: { models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" }, embedding: { provider: "acme", id: "e1", baseUrl: server.baseUrl } } } });
			env.deps.resolveApiKey = (p) => (p === "acme" ? "acme-key-123456" : undefined);
			const old = addMemory(env.deps.db, { scope: "user", type: "fact", content: "alpha note", importance: 0.5, source: "user" }, env.deps.redact, new Date().toISOString());
			script(env, ["Done.", reflection([lesson("beta lesson")]), delta([{ op: "add", type: "lesson", scope: "user", content: "beta lesson", importance: 0.5 }])]);
			const { result, learnEnv } = await finishedRun(env);
			queueJob(env, result.trajectoryId as string, "run_end");
			expect((await new LearnWorker(learnEnv).drain()).succeeded).toBe(1);
			const ids = listMemories(env.deps.db).map((m) => m.id);
			const vectors = getEmbeddings(env.deps.db, ids, "acme/e1");
			expect([...(vectors.get(old.id) ?? [])]).toEqual([1, 0]);
			expect(vectors.size).toBe(2);
			const embedSpans = listSpans(env.deps.db, result.trajectoryId as string).filter((sp) => sp.kind === "embedding_call" && sp.attrs.purpose !== "query");
			expect(embedSpans.map((sp) => [sp.tier, sp.costUnknown, sp.attrs.purpose])).toEqual([
				["embedding", true, "backfill"],
				["embedding", true, "memory"],
			]);
		} finally {
			await server.close();
		}
	});
});
