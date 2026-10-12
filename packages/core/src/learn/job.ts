import { existsSync } from "node:fs";
import {
	applyCuratorDelta,
	CURATOR_SYSTEM,
	CuratorDeltaSchema,
	type CurationResult,
	curatorPrompt,
	REFLECTOR_SYSTEM,
	ReflectionSchema,
	reflectorPrompt,
	relevanceScores,
} from "@nexo/memory";
import { renderTrajectory } from "@nexo/scorers";
import {
	ftsScores,
	getRun,
	isSkillName,
	latestFeedback,
	type LearnJobRow,
	listPlaybookItems,
	listScores,
	listSpans,
	liveMemories,
	memoriesWithoutEmbedding,
	putEmbedding,
	readRunJson,
	RunDir,
	type SpanRow,
} from "@nexo/store";
import { NexoError, toErrorPayload } from "@nexo/telemetry";
import { Recorder } from "../engine/recorder.ts";
import type { EngineEnv } from "../engine/run.ts";
import { summarizeSpans } from "../scoring/runner.ts";
import { type ChargedCallDeps, embedCharged, learnBudget, ledgerCharge, structuredLearnCall } from "./caller.ts";
import { embeddingEndpoint, type FetchLike } from "./embedder.ts";

/** Memories without a vector that one job embeds before reflecting (user-added and older memories catch up this way). */
export const EMBED_BACKFILL_PER_JOB = 32;
/** Related memories shown to the curator. */
const CURATOR_MEMORIES = 30;

export interface LearnJobOutcome {
	lessons: number;
	curation: CurationResult | null;
	costUsd: number;
	costUnknown: boolean;
}

/** Skills a run used: its `--skill` and every skill it loaded successfully with load_skill. */
export function skillsUsed(skill: string | null, spans: readonly SpanRow[]): string[] {
	const names = new Set<string>();
	if (skill) names.add(skill);
	for (const s of spans) {
		const name = (s.attrs.args as { name?: unknown } | undefined)?.name;
		if (s.kind === "skill_load" && s.status === "ok" && isSkillName(name)) names.add(name);
	}
	return [...names].sort();
}

/**
 * Runs one reflect job (spec §8.1): reads the run, its latest scores and verdict, asks the reflector for lessons, asks
 * the curator for deltas and applies them through the guarded store. Every model call is a span on the learned run under
 * one `learn` span, and the applied delta is a `memory_write` span. Throws on any failure (the worker records it on the
 * job); the run itself is never changed.
 */
export async function runLearnJob(env: EngineEnv, job: LearnJobRow, options: { signal: AbortSignal; fetch?: FetchLike }): Promise<LearnJobOutcome> {
	const { db, config, redact, logger } = env.deps;
	const run = getRun(db, job.runId);
	if (!run) throw new NexoError({ code: "NOT_FOUND", message: `Run ${job.runId} does not exist`, context: { runId: job.runId } });
	if (run.status === "running") throw new NexoError({ code: "CONFLICT", message: `Run ${run.id} is still running`, retryable: true, context: { runId: run.id } });
	if (!existsSync(run.dirPath)) throw new NexoError({ code: "NOT_FOUND", message: `The directory of run ${run.id} is gone`, context: { runId: run.id, dir: run.dirPath } });
	const budget = learnBudget(db, config, env.now());
	const recorder = new Recorder({ db, runDir: new RunDir(run.dirPath, run.id, redact), runId: run.id, now: env.now, redact });
	const learnSpan = recorder.start({ kind: "learn", name: "reflect", parentSpanId: null, attrs: { jobId: job.id, trigger: job.trigger, attempt: job.attempts } });
	let costUsd = 0;
	let costUnknown = false;
	const toLedgers = ledgerCharge(db, env.now);
	const deps: ChargedCallDeps = {
		env,
		recorder,
		parentSpanId: learnSpan,
		budget,
		signal: options.signal,
		...(options.fetch ? { fetch: options.fetch } : {}),
		charge: (usd, unknown) => {
			toLedgers(usd);
			costUsd += usd;
			costUnknown ||= unknown;
		},
	};
	try {
		const endpoint = embeddingEndpoint(config);
		if (endpoint) {
			const missing = memoriesWithoutEmbedding(db, endpoint.model, EMBED_BACKFILL_PER_JOB);
			try {
				const vectors = await embedCharged(deps, endpoint, missing.map((m) => m.content), "backfill");
				missing.forEach((m, i) => {
					const v = vectors[i];
					if (v) putEmbedding(db, m.id, endpoint.model, v, env.now().toISOString());
				});
			} catch (error) {
				if (options.signal.aborted) throw error;
				logger.warn("embedding backfill failed; continuing without it", { run_id: run.id, error });
			}
		}

		const spans = listSpans(db, run.id);
		const skills = skillsUsed(run.skill, spans);
		const playbooks = skills.map((name) => ({ name, items: listPlaybookItems(db, name).map((i) => ({ key: i.key, source: i.source, content: i.content })) }));
		const scores = listScores(db, run.id);
		const lastRound = Math.max(-1, ...scores.map((s) => s.round));
		let output = "";
		try {
			output = readRunJson(run.dirPath).output ?? "";
		} catch {
			output = "";
		}
		const feedback = latestFeedback(db, run.id);
		const reflection = await structuredLearnCall(deps, ReflectionSchema, {
			system: REFLECTOR_SYSTEM,
			user: reflectorPrompt({
				instruction: run.instruction,
				status: run.status,
				output,
				trajectory: renderTrajectory(summarizeSpans(spans), 6000),
				scores: scores
					.filter((s) => s.round === lastRound)
					.map((s) => ({ name: s.scorerName, status: s.status, value: s.value, passed: s.passed, rationale: s.rationale })),
				verdict: feedback ? { verdict: feedback.verdict, comment: feedback.comment } : null,
				skills: playbooks,
			}),
			tier: "reflector",
		});
		if (reflection.lessons.length === 0 && reflection.playbookTags.length === 0) {
			return { lessons: 0, curation: null, costUsd, costUnknown };
		}

		const scopes = ["user", "global", ...skills.map((s) => `skill:${s}`)];
		const candidates = liveMemories(db, scopes);
		const relevance = relevanceScores(candidates, ftsScores(db, reflection.lessons.map((l) => l.content).join("\n"), scopes), null);
		const related = [...candidates]
			.sort((a, b) => (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0) || b.createdAt.localeCompare(a.createdAt))
			.slice(0, CURATOR_MEMORIES);
		const delta =
			reflection.lessons.length === 0
				? { memory: [], playbook: [] }
				: await structuredLearnCall(deps, CuratorDeltaSchema, {
						system: CURATOR_SYSTEM,
						user: curatorPrompt({ lessons: reflection.lessons, memories: related, skills: playbooks }),
						tier: "curator",
					});

		const vectors = new Map<string, number[]>();
		const texts = [...new Set(delta.memory.flatMap((op) => (op.op === "noop" ? [] : [op.content])))];
		if (endpoint && texts.length > 0) {
			try {
				const embedded = await embedCharged(deps, endpoint, texts, "memory");
				texts.forEach((t, i) => {
					const v = embedded[i];
					if (v) vectors.set(t, v);
				});
			} catch (error) {
				if (options.signal.aborted) throw error;
				logger.warn("embedding new memories failed; dedup falls back to word overlap", { run_id: run.id, error });
			}
		}
		const writeSpan = recorder.start({ kind: "memory_write", name: "curate", parentSpanId: learnSpan, attrs: { delta: redact(delta) } });
		let curation: CurationResult;
		try {
			curation = applyCuratorDelta(db, {
				runId: run.id,
				delta,
				tags: reflection.playbookTags,
				skills,
				maxPlaybookItems: config.learning.maxPlaybookItems,
				vectors,
				embeddingModel: endpoint?.model ?? null,
				redact,
				nowIso: env.now().toISOString(),
			});
		} catch (error) {
			recorder.finish(writeSpan, { status: "error", attrs: { error: redact(toErrorPayload(error)) } });
			throw error;
		}
		recorder.finish(writeSpan, { status: "ok", attrs: { result: curation } });
		return { lessons: reflection.lessons.length, curation, costUsd, costUnknown };
	} catch (error) {
		recorder.finish(learnSpan, { status: "error", costUsd: 0, attrs: { error: redact(toErrorPayload(error)), totalCostUsd: costUsd } });
		throw error;
	} finally {
		if (recorder.get(learnSpan)?.status === "running") recorder.finish(learnSpan, { status: "ok", costUsd: 0, attrs: { totalCostUsd: costUsd } });
	}
}
