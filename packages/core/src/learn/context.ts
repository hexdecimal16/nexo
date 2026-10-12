import { memoryBlock, type RetrieveOptions, retrieveMemories } from "@nexo/memory";
import { type ArtifactRow, getActiveArtifact } from "@nexo/store";
import { toErrorPayload } from "@nexo/telemetry";
import type { NexoConfig } from "../config/schema.ts";
import { type ChargedCallDeps, embedCharged } from "./caller.ts";
import { embeddingEndpoint } from "./embedder.ts";

/** What a run injected from memory: the system-prompt block, the memory ids and the query embedding (reused by load_skill). */
export interface RunMemoryContext {
	block: string;
	ids: Set<string>;
	query: string;
	embedding: { model: string; vector: number[] } | null;
}

export const EMPTY_MEMORY_CONTEXT: RunMemoryContext = { block: "", ids: new Set(), query: "", embedding: null };

function rankOptions(config: NexoConfig, now: Date): Pick<RetrieveOptions, "weights" | "tauDays" | "now" | "topK"> {
	return { weights: config.memory.weights, tauDays: config.memory.tauDays, now, topK: config.memory.topK };
}

/**
 * Retrieval at run start (spec §8.3): embeds the instruction when `models.embedding` is set (charged to the run through
 * `deps`; a failure falls back to FTS relevance), ranks the live memories of `scopes`, and records a `memory_read` span
 * with the chosen ids and scores. Never throws for a retrieval problem: the run goes on without memories.
 */
export async function retrieveRunMemories(deps: ChargedCallDeps, instruction: string, scopes: readonly string[]): Promise<RunMemoryContext> {
	const { config, db, logger, redact } = deps.env.deps;
	if (!config.memory.enabled || config.memory.maxTokens <= 0) return EMPTY_MEMORY_CONTEXT;
	const spanId = deps.recorder.start({ kind: "memory_read", name: "retrieve", parentSpanId: deps.parentSpanId, attrs: { scopes } });
	let embedding: RunMemoryContext["embedding"] = null;
	let embeddingError: unknown = null;
	try {
		const endpoint = embeddingEndpoint(config);
		if (endpoint && instruction.trim()) {
			try {
				const [vector] = await embedCharged({ ...deps, parentSpanId: spanId }, endpoint, [instruction.slice(0, 8000)], "query");
				if (vector) embedding = { model: endpoint.model, vector };
			} catch (error) {
				if (deps.signal.aborted) throw error;
				embeddingError = redact(toErrorPayload(error));
				logger.warn("query embedding failed; memory relevance falls back to full-text search", { error });
			}
		}
		const result = retrieveMemories(db, { ...rankOptions(config, deps.env.now()), query: instruction, scopes, maxTokens: config.memory.maxTokens, embedding });
		const memories = result.selected.map((r) => r.memory);
		deps.recorder.finish(spanId, {
			status: "ok",
			attrs: {
				mode: result.mode,
				candidates: result.candidates,
				selected: result.selected.map((r) => ({ id: r.memory.id, score: Number(r.score.toFixed(4)), relevance: Number(r.relevance.toFixed(4)) })),
				...(embeddingError ? { embeddingError } : {}),
			},
		});
		return { block: memoryBlock(memories), ids: new Set(memories.map((m) => m.id)), query: instruction, embedding };
	} catch (error) {
		deps.recorder.finish(spanId, { status: "error", attrs: { error: redact(toErrorPayload(error)) } });
		if (deps.signal.aborted) throw error;
		logger.warn("memory retrieval failed; the run continues without memories", { error });
		return EMPTY_MEMORY_CONTEXT;
	}
}

/** The active playbook artifact of a skill, or undefined when it has none or it is empty. */
export function activePlaybook(deps: ChargedCallDeps, skill: string): ArtifactRow | undefined {
	const artifact = getActiveArtifact(deps.env.deps.db, "playbook", skill);
	return artifact && artifact.content.trim() ? artifact : undefined;
}

/** The playbook section appended to a skill (spec §6). */
export function playbookSection(skill: string, content: string): string {
	return `## Playbook for ${skill}\nTips learned for this skill in earlier runs, by key. Follow them where they apply; the user's instruction wins when they conflict.\n${content}`;
}

/**
 * What `load_skill(name)` appends to the skill body: its active playbook and the best `skill:<name>` memories not
 * already in context (half of `memory.maxTokens`, ranked against the run's instruction with the run's query embedding).
 * Each memory shown is added to `context.ids`.
 */
export function skillAppendix(deps: ChargedCallDeps, context: RunMemoryContext, skill: string): string {
	const { config, db, logger } = deps.env.deps;
	const parts: string[] = [];
	const playbook = activePlaybook(deps, skill);
	if (playbook) parts.push(playbookSection(skill, playbook.content));
	if (config.memory.enabled && config.memory.maxTokens > 0) {
		try {
			const result = retrieveMemories(db, {
				...rankOptions(config, deps.env.now()),
				query: context.query,
				scopes: [`skill:${skill}`],
				maxTokens: Math.floor(config.memory.maxTokens / 2),
				embedding: context.embedding,
				exclude: context.ids,
			});
			for (const r of result.selected) context.ids.add(r.memory.id);
			const block = memoryBlock(result.selected.map((r) => r.memory));
			if (block) parts.push(block);
		} catch (error) {
			logger.warn("skill memory retrieval failed", { skill, error });
		}
	}
	return parts.join("\n\n");
}
