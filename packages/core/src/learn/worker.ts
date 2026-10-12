import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { claimLearnJob, failLearnJob, type LearnJobRow, reclaimStaleLearnJobs, releaseLearnJob } from "@nexo/store";
import { NexoError, toErrorPayload } from "@nexo/telemetry";
import type { EngineEnv } from "../engine/run.ts";
import type { FetchLike } from "./embedder.ts";
import { LearnClaimLostError, type LearnJobOutcome, runLearnJob } from "./job.ts";

export interface DrainOptions {
	/** Most jobs to run in this drain. */
	maxJobs?: number;
	/** Stops between jobs and aborts the running job (released back to pending) after this many milliseconds. */
	deadlineMs?: number;
	signal?: AbortSignal;
}

export interface DrainResult {
	succeeded: number;
	failed: number;
	/** Jobs put back to pending because the drain was stopped. */
	released: number;
}

export type LearnEvent =
	| { type: "job_start"; job: LearnJobRow }
	| { type: "job_end"; job: LearnJobRow; ok: true; outcome: LearnJobOutcome }
	| { type: "job_end"; job: LearnJobRow; ok: false; error: { code: string; message: string } };

export interface LearnWorkerOptions {
	/** Defaults to `<host>:<pid>:<random>`. */
	workerId?: string;
	fetch?: FetchLike;
	onEvent?: (event: LearnEvent) => void;
}

/** Part of `learning.staleMinutes` a job may run before it is aborted, so it ends before other workers reclaim it. */
const JOB_DEADLINE_SHARE = 0.8;

/**
 * Runs learn jobs one at a time in this process (spec §8.1: in the background, never blocking or failing a run). Jobs
 * are taken with the store's atomic claim, so several processes can drain one database; a job that is still running
 * after 0.8 × `learning.staleMinutes` is aborted and fails. With `learning.enabled: false` a drain does nothing.
 */
export class LearnWorker {
	readonly workerId: string;
	private readonly env: EngineEnv;
	private readonly options: LearnWorkerOptions;
	private background: Promise<DrainResult> | null = null;
	private again = false;
	private readonly stopController = new AbortController();
	/** The job this worker is running, if any. */
	private current: LearnJobRow | null = null;
	/** The id of the job `stop` put back to pending. */
	private releasedOnStop: string | null = null;

	constructor(env: EngineEnv, options: LearnWorkerOptions = {}) {
		this.env = env;
		this.options = options;
		this.workerId = options.workerId ?? `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
	}

	/** Runs pending jobs until none is left, `maxJobs` ran, the deadline passed or the signal aborted. */
	async drain(options: DrainOptions = {}): Promise<DrainResult> {
		const result: DrainResult = { succeeded: 0, failed: 0, released: 0 };
		const { config, db, logger, redact } = this.env.deps;
		if (!config.learning.enabled || this.stopController.signal.aborted) return result;
		const signals = [this.stopController.signal];
		if (options.signal) signals.push(options.signal);
		if (options.deadlineMs !== undefined) signals.push(AbortSignal.timeout(Math.max(0, options.deadlineMs)));
		const signal = AbortSignal.any(signals);
		const now = this.env.now();
		const stale = reclaimStaleLearnJobs(db, new Date(now.getTime() - config.learning.staleMinutes * 60_000).toISOString(), now.toISOString());
		if (stale.pending.length + stale.failed.length > 0) logger.warn("reclaimed learn jobs left running by a stopped process", { pending: stale.pending, failed: stale.failed });
		const max = options.maxJobs ?? Number.POSITIVE_INFINITY;
		while (result.succeeded + result.failed < max && !signal.aborted) {
			const job = claimLearnJob(db, this.workerId, this.env.now().toISOString());
			if (!job) break;
			this.options.onEvent?.({ type: "job_start", job });
			this.current = job;
			const deadlineMs = config.learning.staleMinutes * 60_000 * JOB_DEADLINE_SHARE;
			const deadline = AbortSignal.timeout(deadlineMs);
			const jobSignal = AbortSignal.any([signal, deadline]);
			try {
				const outcome = await runLearnJob(this.env, job, { workerId: this.workerId, signal: jobSignal, ...(this.options.fetch ? { fetch: this.options.fetch } : {}) });
				result.succeeded++;
				logger.info("learn job succeeded", { job_id: job.id, run_id: job.runId, lessons: outcome.lessons, cost_usd: outcome.costUsd });
				this.options.onEvent?.({ type: "job_end", job, ok: true, outcome });
			} catch (error) {
				if (error instanceof LearnClaimLostError) {
					logger.warn("learn job lost its claim; another worker owns it, nothing was written", { job_id: job.id, run_id: job.runId });
					continue;
				}
				if (signal.aborted) {
					if (releaseLearnJob(db, job.id, this.workerId, this.env.now().toISOString()) || this.releasedOnStop === job.id) result.released++;
					else logger.warn("learn job lost its claim while stopping", { job_id: job.id, run_id: job.runId });
					break;
				}
				const cause = deadline.aborted
					? new NexoError({
							code: "PROVIDER_TIMEOUT",
							message: `The learn job ran past its deadline of ${Math.round(deadlineMs / 1000)} s (0.8 × learning.staleMinutes)`,
							retryable: true,
							hint: "Raise learning.staleMinutes, or retry with `nexo learn --retry`",
						})
					: error;
				const payload = redact(toErrorPayload(cause));
				if (!failLearnJob(db, job.id, this.workerId, payload, this.env.now().toISOString())) {
					logger.warn("learn job lost its claim; another worker owns it", { job_id: job.id, run_id: job.runId, error: payload });
					continue;
				}
				result.failed++;
				logger.warn("learn job failed", { job_id: job.id, run_id: job.runId, error: payload });
				this.options.onEvent?.({ type: "job_end", job, ok: false, error: { code: payload.code, message: payload.message } });
			} finally {
				this.current = null;
			}
		}
		return result;
	}

	/** Starts a background drain, or asks the running one to look again when it finishes. Never throws; failures are logged. */
	kick(): void {
		if (this.stopController.signal.aborted) return;
		if (this.background) {
			this.again = true;
			return;
		}
		const loop = async (): Promise<DrainResult> => {
			const total: DrainResult = { succeeded: 0, failed: 0, released: 0 };
			do {
				this.again = false;
				const r = await this.drain();
				total.succeeded += r.succeeded;
				total.failed += r.failed;
				total.released += r.released;
			} while (this.again && !this.stopController.signal.aborted);
			return total;
		};
		this.background = loop()
			.catch((error: unknown) => {
				this.env.deps.logger.error("learn worker failed", { error });
				return { succeeded: 0, failed: 0, released: 0 };
			})
			.finally(() => {
				this.background = null;
			});
	}

	/** Resolves when the background drain started by `kick` has finished (immediately when none runs). */
	async idle(): Promise<void> {
		while (this.background) await this.background;
	}

	/**
	 * Stops the worker: the running job is aborted and put back to pending (attempt not counted) before this returns its
	 * promise, so the release is written even when the process exits right after. The promise resolves once the aborted
	 * job has unwound.
	 */
	async stop(): Promise<void> {
		this.stopController.abort();
		const job = this.current;
		if (job && releaseLearnJob(this.env.deps.db, job.id, this.workerId, this.env.now().toISOString())) this.releasedOnStop = job.id;
		await this.idle();
	}
}
