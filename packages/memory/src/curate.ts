import {
	addMemory,
	addPlaybookItem,
	type Db,
	getEmbeddings,
	isMemoryScope,
	liveMemories,
	listPlaybookItems,
	prunePlaybook,
	publishPlaybook,
	putEmbedding,
	retirePlaybookItem,
	supersedeMemory,
	tagPlaybookItem,
	transaction,
	updatePlaybookItem,
} from "@nexo/store";
import { NexoError, type Redactor } from "@nexo/telemetry";
import type { CuratorDelta, Reflection } from "./prompts.ts";
import { isDuplicate } from "./similarity.ts";

export interface CurationInput {
	runId: string;
	delta: CuratorDelta;
	tags: Reflection["playbookTags"];
	/** Skills the run used; playbook ops, tags and `skill:` scopes for any other skill are rejected. */
	skills: readonly string[];
	/** The `project:<id>` scope of the run's repository; "project" ops map to it, and other projects' scopes are rejected. Null when the run had no project. */
	projectScope?: string | null;
	maxPlaybookItems: number;
	/** Embeddings of proposed memory texts (keyed by the text as proposed), from `embeddingModel`. */
	vectors?: ReadonlyMap<string, ArrayLike<number>>;
	embeddingModel?: string | null;
	redact: Redactor;
	nowIso: string;
}

export interface RejectedOp {
	list: "memory" | "playbook" | "tags";
	index: number;
	code: string;
	message: string;
}

export interface CurationResult {
	memoriesAdded: string[];
	memoriesSuperseded: { from: string; to: string }[];
	duplicates: number;
	noops: number;
	itemsAdded: { skill: string; key: string }[];
	itemsUpdated: { skill: string; key: string }[];
	itemsRetired: { skill: string; key: string }[];
	itemsPruned: { skill: string; key: string }[];
	tagged: number;
	playbookVersions: { skill: string; artifactId: string; version: number }[];
	rejected: RejectedOp[];
}

/** Store refusals that reject one op; anything else aborts the whole batch. */
const REJECTABLE = new Set(["FORBIDDEN", "NOT_FOUND", "CONFLICT", "INVALID_REQUEST"]);

function rejection(list: RejectedOp["list"], index: number, code: string, message: string): RejectedOp {
	return { list, index, code, message };
}

/**
 * Applies one curator delta in a single transaction (spec §8.1). Each op goes through the guarded store functions as the
 * curator (`actor: "ace"`): an op the store refuses (a human or user memory or item, an unknown id, a skill the run did
 * not use) is recorded in `rejected` and the rest still applies. New memories and items that duplicate a live one in
 * the same scope or skill are skipped. Each skill whose items changed is pruned to `maxPlaybookItems` (never a human
 * item) and gets a new `playbook` artifact version with origin `ace` when its text changed.
 */
export function applyCuratorDelta(db: Db, input: CurationInput): CurationResult {
	const result: CurationResult = {
		memoriesAdded: [],
		memoriesSuperseded: [],
		duplicates: 0,
		noops: 0,
		itemsAdded: [],
		itemsUpdated: [],
		itemsRetired: [],
		itemsPruned: [],
		tagged: 0,
		playbookVersions: [],
		rejected: [],
	};
	const allowed = new Set(input.skills);
	const { redact, nowIso, runId } = input;
	const vectorOf = (text: string) => input.vectors?.get(text) ?? null;
	const storeVector = (memoryId: string, text: string) => {
		const v = vectorOf(text);
		if (v && input.embeddingModel) putEmbedding(db, memoryId, input.embeddingModel, v, nowIso);
	};
	const guarded = (list: RejectedOp["list"], index: number, fn: () => void) => {
		try {
			fn();
		} catch (error) {
			if (error instanceof NexoError && REJECTABLE.has(error.code)) result.rejected.push(rejection(list, index, error.code, error.message));
			else throw error;
		}
	};
	const changedSkills = new Set<string>();

	transaction(db, () => {
		input.delta.memory.forEach((op, index) =>
			guarded("memory", index, () => {
				if (op.op === "noop") {
					result.noops++;
					return;
				}
				if (op.op === "add") {
					const scope = op.scope === "project" ? (input.projectScope ?? op.scope) : op.scope;
					const skill = scope.startsWith("skill:") ? scope.slice("skill:".length) : null;
					if (!isMemoryScope(scope) || (skill !== null && !allowed.has(skill))) {
						throw new NexoError({ code: "INVALID_REQUEST", message: `The run did not use a skill or project for scope ${op.scope}` });
					}
					if (scope.startsWith("project:") && scope !== input.projectScope) {
						throw new NexoError({ code: "INVALID_REQUEST", message: `The run did not work in project ${scope}` });
					}
					const live = liveMemories(db, [scope]);
					const vectors = input.embeddingModel ? getEmbeddings(db, live.map((m) => m.id), input.embeddingModel) : new Map<string, Float32Array>();
					const candidate = { text: redact(op.content), vector: vectorOf(op.content) };
					if (live.some((m) => isDuplicate(candidate, { text: m.content, vector: vectors.get(m.id) ?? null }))) {
						result.duplicates++;
						return;
					}
					const row = addMemory(db, { scope, type: op.type, content: op.content, importance: op.importance, source: "ace", sourceRunId: runId }, redact, nowIso);
					storeVector(row.id, op.content);
					result.memoriesAdded.push(row.id);
					return;
				}
				const next = supersedeMemory(
					db,
					op.id,
					{ content: op.content, ...(op.importance === undefined ? {} : { importance: op.importance }), sourceRunId: runId },
					"ace",
					redact,
					nowIso,
				);
				storeVector(next.id, op.content);
				result.memoriesSuperseded.push({ from: op.id, to: next.id });
			}),
		);

		input.delta.playbook.forEach((op, index) =>
			guarded("playbook", index, () => {
				if (!allowed.has(op.skill)) throw new NexoError({ code: "INVALID_REQUEST", message: `The run did not use skill ${op.skill}` });
				if (op.op === "add") {
					const text = redact(op.content);
					if (listPlaybookItems(db, op.skill).some((i) => isDuplicate({ text }, { text: i.content }))) {
						result.duplicates++;
						return;
					}
					const item = addPlaybookItem(db, { skill: op.skill, content: op.content, source: "ace", runId }, redact, nowIso);
					result.itemsAdded.push({ skill: op.skill, key: item.key });
				} else if (op.op === "update") {
					updatePlaybookItem(db, op.skill, op.key, op.content, "ace", redact, nowIso, runId);
					result.itemsUpdated.push({ skill: op.skill, key: op.key });
				} else {
					retirePlaybookItem(db, op.skill, op.key, "ace", nowIso, runId);
					result.itemsRetired.push({ skill: op.skill, key: op.key });
				}
				changedSkills.add(op.skill);
			}),
		);

		input.tags.forEach((tag, index) => {
			if (!allowed.has(tag.skill)) {
				result.rejected.push(rejection("tags", index, "INVALID_REQUEST", `The run did not use skill ${tag.skill}`));
				return;
			}
			if (tagPlaybookItem(db, tag.skill, tag.key, tag.tag, runId, nowIso)) result.tagged++;
		});

		for (const skill of [...changedSkills].sort()) {
			for (const key of prunePlaybook(db, skill, input.maxPlaybookItems, nowIso, runId)) result.itemsPruned.push({ skill, key });
			const version = publishPlaybook(db, skill, "ace", nowIso);
			if (version) result.playbookVersions.push({ skill, artifactId: version.id, version: version.version });
		}
	});
	return result;
}

/** True when the result changed any memory or playbook state. */
export function curationChanged(result: CurationResult): boolean {
	return (
		result.memoriesAdded.length + result.memoriesSuperseded.length + result.itemsAdded.length + result.itemsUpdated.length + result.itemsRetired.length + result.tagged >
		0
	);
}
