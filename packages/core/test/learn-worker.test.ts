import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { claimLearnJob, getLearnJob, listLearnJobs } from "@nexo/store";
import { createEngine, createEngineEnv, LearnWorker } from "../src/index.ts";
import { makeEnv, queueJob, reflection, script } from "./learn-helpers.ts";

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
});
