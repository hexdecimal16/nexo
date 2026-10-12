import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { claimLearnJob, getLearnJob, listLearnJobs, listMemories, retryFailedLearnJobs } from "@nexo/store";
import { createEngine, createEngineEnv, createSession, LearnWorker } from "../src/index.ts";
import { delta, lesson, makeEnv, queueJob, reflection, script } from "./learn-helpers.ts";

async function runs(env: ReturnType<typeof makeEnv>, n: number): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const r = await createEngine(env.deps).run({ instruction: `task ${i}` });
		ids.push(r.trajectoryId as string);
	}
	return ids;
}

describe("LearnWorker", () => {
	it("two workers on one database run each job once", async () => {
		const env = makeEnv();
		const s = script(env, [...Array.from({ length: 6 }, () => "ok"), ...Array.from({ length: 6 }, () => reflection())]);
		const ids = await runs(env, 6);
		for (const runId of ids) queueJob(env, runId, "run_end");
		const learnEnv = createEngineEnv(env.deps);
		const [a, b] = await Promise.all([new LearnWorker(learnEnv, { workerId: "ui" }).drain(), new LearnWorker(learnEnv, { workerId: "tui" }).drain()]);
		expect(a.succeeded + b.succeeded).toBe(6);
		expect(s.calls()).toBe(12);
		expect(listLearnJobs(env.deps.db, { status: "succeeded" })).toHaveLength(6);
	});

	it("reclaims a job left running by a crashed process", async () => {
		const env = makeEnv();
		script(env, ["ok", reflection()]);
		const [runId] = await runs(env, 1);
		const job = queueJob(env, runId as string, "run_end");
		claimLearnJob(env.deps.db, "crashed", new Date(Date.now() - 60 * 60_000).toISOString());
		const result = await new LearnWorker(createEngineEnv(env.deps)).drain();
		expect(result.succeeded).toBe(1);
		expect(getLearnJob(env.deps.db, job.id)).toMatchObject({ status: "succeeded", attempts: 2 });
	});

	it("leaves a job another live worker is running alone", async () => {
		const env = makeEnv();
		script(env, ["ok"]);
		const [runId] = await runs(env, 1);
		const job = queueJob(env, runId as string, "run_end");
		claimLearnJob(env.deps.db, "busy", new Date().toISOString());
		expect(await new LearnWorker(createEngineEnv(env.deps)).drain()).toEqual({ succeeded: 0, failed: 0, released: 0 });
		expect(getLearnJob(env.deps.db, job.id)).toMatchObject({ status: "running", claimedBy: "busy" });
	});

	it("releases the running job back to pending when stopped, without counting the attempt", async () => {
		const env = makeEnv();
		let started!: () => void;
		const begun = new Promise<void>((resolve) => (started = resolve));
		script(env, [
			"ok",
			(_ctx, opts) =>
				new Promise((resolve) => {
					started();
					opts?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
				}),
		]);
		const [runId] = await runs(env, 1);
		const job = queueJob(env, runId as string, "run_end");
		const worker = new LearnWorker(createEngineEnv(env.deps));
		worker.kick();
		await begun;
		await worker.stop();
		expect(getLearnJob(env.deps.db, job.id)).toMatchObject({ status: "pending", attempts: 0, claimedBy: null });
		worker.kick();
		await worker.idle();
		expect(getLearnJob(env.deps.db, job.id)?.status).toBe("pending");
	});

	it("stops at the deadline and keeps the remaining jobs pending", async () => {
		const env = makeEnv();
		script(env, [
			"ok",
			"ok",
			(_ctx, opts) => new Promise((resolve) => opts?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true })),
		]);
		const ids = await runs(env, 2);
		for (const runId of ids) queueJob(env, runId, "run_end");
		const result = await new LearnWorker(createEngineEnv(env.deps)).drain({ deadlineMs: 50 });
		expect(result).toEqual({ succeeded: 0, failed: 0, released: 1 });
		expect(listLearnJobs(env.deps.db, { status: "pending" })).toHaveLength(2);
	});

	it("does nothing when learning is disabled", async () => {
		const env = makeEnv({ config: { learning: { enabled: false } } });
		const s = script(env, ["ok"]);
		const [runId] = await runs(env, 1);
		queueJob(env, runId as string, "run_end");
		expect(await new LearnWorker(createEngineEnv(env.deps)).drain()).toEqual({ succeeded: 0, failed: 0, released: 0 });
		expect(s.calls()).toBe(1);
	});
	it("writes nothing and counts nothing when another worker took the job over before the delta is applied", async () => {
		const env = makeEnv();
		let jobId = "";
		script(env, [
			"ok",
			reflection([lesson("Run the linter first")]),
			() => {
				// A second process reclaimed the job as stale and claimed it while this curator call ran.
				env.deps.db.prepare("UPDATE learn_jobs SET claimed_by = 'other', claimed_at = ? WHERE id = ?").run(new Date().toISOString(), jobId);
				return fauxAssistantMessage(delta([{ op: "add", type: "lesson", scope: "user", content: "Run the linter first", importance: 0.6 }]));
			},
		]);
		const [runId] = await runs(env, 1);
		jobId = queueJob(env, runId as string, "run_end").id;
		expect(await new LearnWorker(createEngineEnv(env.deps), { workerId: "me" }).drain()).toEqual({ succeeded: 0, failed: 0, released: 0 });
		expect(listMemories(env.deps.db)).toEqual([]);
		expect(getLearnJob(env.deps.db, jobId)).toMatchObject({ status: "running", claimedBy: "other" });
	});

	it("rolls the applied delta back when the job cannot be marked succeeded, so a retry applies it once", async () => {
		const env = makeEnv();
		const replies = [reflection([lesson("Run the linter first")]), delta([{ op: "add", type: "lesson", scope: "user", content: "Run the linter first", importance: 0.6 }])];
		script(env, ["ok", ...replies, ...replies]);
		const [runId] = await runs(env, 1);
		const job = queueJob(env, runId as string, "run_end");
		env.deps.db.exec("CREATE TRIGGER no_success BEFORE UPDATE OF status ON learn_jobs WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
		expect((await new LearnWorker(createEngineEnv(env.deps)).drain()).failed).toBe(1);
		expect(getLearnJob(env.deps.db, job.id)?.status).toBe("failed");
		expect(listMemories(env.deps.db)).toEqual([]);
		env.deps.db.exec("DROP TRIGGER no_success");
		expect(retryFailedLearnJobs(env.deps.db, new Date().toISOString())).toBe(1);
		expect((await new LearnWorker(createEngineEnv(env.deps)).drain()).succeeded).toBe(1);
		expect(listMemories(env.deps.db).map((m) => m.content)).toEqual(["Run the linter first"]);
	});

	it("puts the running job back to pending, uncounted, as soon as the session closes", async () => {
		const env = makeEnv();
		let started!: () => void;
		const begun = new Promise<void>((resolve) => (started = resolve));
		script(env, [
			"answer",
			(_ctx, opts) =>
				new Promise((resolve) => {
					started();
					opts?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
				}),
		]);
		const session = createSession(env.deps, { cwd: realpathSync(mkdtempSync(join(tmpdir(), "nexo-learn-cwd-"))) });
		const result = await session.turn("hi");
		await begun;
		session.close();
		// No await between close and the check: the release lands before a process.exit could.
		expect(listLearnJobs(env.deps.db, { runId: result.trajectoryId as string })).toEqual([expect.objectContaining({ status: "pending", attempts: 0, claimedBy: null })]);
	});
});
