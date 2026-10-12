import { NexoError, type Redactor } from "@nexo/telemetry";
import { appendArtifactVersion, type ArtifactRow, getActiveArtifact } from "./artifacts.ts";
import type { Db } from "./db.ts";
import { transaction } from "./db.ts";
import { invalidRequest } from "./errors.ts";
import { newId } from "./ids.ts";
import type { LearningActor } from "./memories.ts";

export type PlaybookItemSource = "ace" | "human";
export type PlaybookTag = "helpful" | "harmful";
export type PlaybookAction = "add" | "update" | "retire" | "helpful" | "harmful" | "prune";

/** Longest playbook item, in characters. */
export const MAX_PLAYBOOK_ITEM_CHARS = 500;

export interface PlaybookItemRow {
	id: string;
	skill: string;
	key: string;
	content: string;
	helpful: number;
	harmful: number;
	source: PlaybookItemSource;
	status: "active" | "retired";
	sourceRunId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface PlaybookHistoryRow {
	id: string;
	itemId: string;
	action: PlaybookAction;
	content: string | null;
	actor: "ace" | "human" | "user";
	runId: string | null;
	createdAt: string;
}

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isSkillName(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && SKILL_NAME.test(value);
}

function assertSkill(skill: string): void {
	if (!isSkillName(skill)) throw invalidRequest("skill must be a skill name ([a-z0-9-], at most 64 characters)", { skill });
}

function decode(row: Record<string, unknown>): PlaybookItemRow {
	return {
		id: String(row.id),
		skill: String(row.artifact_name),
		key: String(row.item_key),
		content: String(row.content),
		helpful: Number(row.helpful),
		harmful: Number(row.harmful),
		source: row.source as PlaybookItemSource,
		status: row.status as PlaybookItemRow["status"],
		sourceRunId: row.source_run_id === null || row.source_run_id === undefined ? null : String(row.source_run_id),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function history(db: Db, itemId: string, action: PlaybookAction, content: string | null, actor: PlaybookHistoryRow["actor"], runId: string | null, nowIso: string): void {
	db.prepare("INSERT INTO playbook_item_history (id, item_id, action, content, actor, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
		newId(),
		itemId,
		action,
		content,
		actor,
		runId,
		nowIso,
	);
}

function cleanContent(content: unknown, redact: Redactor): string {
	const text = typeof content === "string" ? redact(content.trim().replace(/\s+/g, " ")) : "";
	if (!text) throw invalidRequest("playbook item content is empty");
	if (text.length > MAX_PLAYBOOK_ITEM_CHARS) throw invalidRequest(`playbook item is longer than ${MAX_PLAYBOOK_ITEM_CHARS} characters`, { length: text.length });
	return text;
}

export function getPlaybookItem(db: Db, skill: string, key: string): PlaybookItemRow | undefined {
	const row = db.prepare("SELECT * FROM playbook_items WHERE artifact_name = ? AND item_key = ?").get(skill, key);
	return row ? decode(row) : undefined;
}

function itemNotFound(skill: string, key: string): NexoError {
	return new NexoError({ code: "NOT_FOUND", message: `Playbook ${skill} has no item ${key}`, context: { skill, key } });
}

/** Items of one skill's playbook in key order; retired ones only when asked. */
export function listPlaybookItems(db: Db, skill: string, options: { includeRetired?: boolean } = {}): PlaybookItemRow[] {
	assertSkill(skill);
	const where = options.includeRetired ? "" : " AND status = 'active'";
	return db.prepare(`SELECT * FROM playbook_items WHERE artifact_name = ?${where} ORDER BY item_key`).all(skill).map(decode);
}

/** Skill names that have a playbook item, in name order. */
export function listPlaybookSkills(db: Db): string[] {
	return db.prepare("SELECT DISTINCT artifact_name AS name FROM playbook_items ORDER BY artifact_name").all().map((r) => String(r.name));
}

/** The next free key of a skill's playbook: k001, k002, … */
function nextKey(db: Db, skill: string): string {
	const rows = db.prepare("SELECT item_key FROM playbook_items WHERE artifact_name = ?").all(skill);
	let max = 0;
	for (const r of rows) {
		const m = /^k(\d+)$/.exec(String(r.item_key));
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `k${String(max + 1).padStart(3, "0")}`;
}

/** Adds an item under the next free key (redacted, length-capped). Throws INVALID_REQUEST. */
export function addPlaybookItem(
	db: Db,
	input: { skill: string; content: string; source: PlaybookItemSource; runId?: string | null },
	redact: Redactor,
	nowIso: string,
): PlaybookItemRow {
	assertSkill(input.skill);
	const content = cleanContent(input.content, redact);
	return transaction(db, () => {
		const row: PlaybookItemRow = {
			id: newId(),
			skill: input.skill,
			key: nextKey(db, input.skill),
			content,
			helpful: 0,
			harmful: 0,
			source: input.source,
			status: "active",
			sourceRunId: input.runId ?? null,
			createdAt: nowIso,
			updatedAt: nowIso,
		};
		db.prepare(
			"INSERT INTO playbook_items (id, artifact_name, item_key, content, helpful, harmful, source, status, source_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, 'active', ?, ?, ?)",
		).run(row.id, row.skill, row.key, content, row.source, row.sourceRunId, nowIso, nowIso);
		history(db, row.id, "add", content, input.source, row.sourceRunId, nowIso);
		return row;
	});
}

function requireActive(db: Db, skill: string, key: string): PlaybookItemRow {
	assertSkill(skill);
	const item = getPlaybookItem(db, skill, key);
	if (!item) throw itemNotFound(skill, key);
	if (item.status !== "active") throw new NexoError({ code: "CONFLICT", message: `Playbook item ${skill}/${key} is retired`, context: { skill, key } });
	return item;
}

function assertMayChange(actor: LearningActor, item: PlaybookItemRow): void {
	if (actor === "ace" && item.source === "human") {
		throw new NexoError({
			code: "FORBIDDEN",
			message: `The curator cannot change the human playbook item ${item.skill}/${item.key}`,
			hint: "Only a user action (the Learning page or `nexo playbook retire`) can change it",
			context: { skill: item.skill, key: item.key, source: item.source },
		});
	}
}

/** Rewrites an item's content. Throws NOT_FOUND, CONFLICT (retired), FORBIDDEN (the curator on a human item), INVALID_REQUEST. */
export function updatePlaybookItem(db: Db, skill: string, key: string, content: string, actor: LearningActor, redact: Redactor, nowIso: string, runId: string | null = null): PlaybookItemRow {
	const text = cleanContent(content, redact);
	return transaction(db, () => {
		const item = requireActive(db, skill, key);
		assertMayChange(actor, item);
		db.prepare("UPDATE playbook_items SET content = ?, updated_at = ? WHERE id = ?").run(text, nowIso, item.id);
		history(db, item.id, "update", text, actor, runId, nowIso);
		return { ...item, content: text, updatedAt: nowIso };
	});
}

/** Retires an item (kept with its history). Throws NOT_FOUND, CONFLICT and FORBIDDEN as `updatePlaybookItem`. */
export function retirePlaybookItem(db: Db, skill: string, key: string, actor: LearningActor, nowIso: string, runId: string | null = null): PlaybookItemRow {
	return transaction(db, () => {
		const item = requireActive(db, skill, key);
		assertMayChange(actor, item);
		db.prepare("UPDATE playbook_items SET status = 'retired', updated_at = ? WHERE id = ?").run(nowIso, item.id);
		history(db, item.id, "retire", null, actor, runId, nowIso);
		return { ...item, status: "retired", updatedAt: nowIso };
	});
}

/** Counts one helpful or harmful use of an active item (human items too: counters are not content). Unknown or retired keys are ignored; returns whether it counted. */
export function tagPlaybookItem(db: Db, skill: string, key: string, tag: PlaybookTag, runId: string | null, nowIso: string): boolean {
	const item = getPlaybookItem(db, skill, key);
	if (!item || item.status !== "active") return false;
	db.prepare(`UPDATE playbook_items SET ${tag === "helpful" ? "helpful = helpful + 1" : "harmful = harmful + 1"}, updated_at = ? WHERE id = ?`).run(nowIso, item.id);
	history(db, item.id, tag, null, "ace", runId, nowIso);
	return true;
}

/** (helpful + 1) / (harmful + 1): the pruning order, lowest first. */
export function playbookItemRatio(item: Pick<PlaybookItemRow, "helpful" | "harmful">): number {
	return (item.helpful + 1) / (item.harmful + 1);
}

/**
 * Keeps at most `max` active items: retires `ace` items with the lowest (helpful+1)/(harmful+1), oldest first on ties.
 * Human items are never pruned, so a playbook with more than `max` human items keeps them all. Returns the pruned keys.
 */
export function prunePlaybook(db: Db, skill: string, max: number, nowIso: string, runId: string | null = null): string[] {
	return transaction(db, () => {
		const items = listPlaybookItems(db, skill);
		const excess = items.length - max;
		if (excess <= 0) return [];
		const candidates = items
			.filter((i) => i.source === "ace")
			.sort((a, b) => playbookItemRatio(a) - playbookItemRatio(b) || a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))
			.slice(0, excess);
		for (const item of candidates) {
			db.prepare("UPDATE playbook_items SET status = 'retired', updated_at = ? WHERE id = ?").run(nowIso, item.id);
			history(db, item.id, "prune", null, "ace", runId, nowIso);
		}
		return candidates.map((i) => i.key);
	});
}

export function playbookItemHistory(db: Db, itemId: string): PlaybookHistoryRow[] {
	return db
		.prepare("SELECT * FROM playbook_item_history WHERE item_id = ? ORDER BY created_at, id")
		.all(itemId)
		.map((r) => ({
			id: String(r.id),
			itemId: String(r.item_id),
			action: r.action as PlaybookAction,
			content: r.content === null ? null : String(r.content),
			actor: r.actor as PlaybookHistoryRow["actor"],
			runId: r.run_id === null ? null : String(r.run_id),
			createdAt: String(r.created_at),
		}));
}

/** The playbook text appended by load_skill: one line per active item, `- [key] content`. Empty without items. */
export function renderPlaybook(items: readonly Pick<PlaybookItemRow, "key" | "content" | "status">[]): string {
	return items
		.filter((i) => i.status === "active")
		.map((i) => `- [${i.key}] ${i.content}`)
		.join("\n");
}

/**
 * Stores the skill's current active items as a new `playbook` artifact version with `origin` when the rendered text
 * changed (an empty playbook too, once one existed). Returns the active version, or undefined when the skill never had
 * a playbook.
 */
export function publishPlaybook(db: Db, skill: string, origin: ArtifactRow["origin"], nowIso: string): ArtifactRow | undefined {
	const content = renderPlaybook(listPlaybookItems(db, skill));
	const active = getActiveArtifact(db, "playbook", skill);
	if (!active && content === "") return undefined;
	return appendArtifactVersion(db, "playbook", skill, content, origin, nowIso);
}
