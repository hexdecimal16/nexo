import { NexoError, type Redactor } from "@nexo/telemetry";
import type { Db } from "./db.ts";
import { transaction } from "./db.ts";
import { checkLimit, checkOffset, decodeCursor, pageOf } from "./cursor.ts";
import { invalidRequest } from "./errors.ts";
import { newId } from "./ids.ts";

export type MemoryType = "fact" | "preference" | "lesson" | "workflow";
export type MemorySource = "ace" | "human" | "user";
/** Who changes learning state: the curator (`ace`), or a person through the UI or CLI (`user`). */
export type LearningActor = "ace" | "user";

export const MEMORY_TYPES: readonly MemoryType[] = ["fact", "preference", "lesson", "workflow"];

/** Longest memory content, in characters. */
export const MAX_MEMORY_CHARS = 1000;
/** Highest importance a curator-written (`ace`) memory may have; human and user memories may reach 1. */
export const MAX_ACE_IMPORTANCE = 0.7;

export interface MemoryRow {
	id: string;
	scope: string;
	type: MemoryType;
	content: string;
	importance: number;
	source: MemorySource;
	sourceRunId: string | null;
	supersededBy: string | null;
	retiredAt: string | null;
	createdAt: string;
	lastUsedAt: string | null;
}

export interface NewMemory {
	scope: string;
	type: MemoryType;
	content: string;
	importance: number;
	source: MemorySource;
	sourceRunId?: string | null;
}

export interface MemoryFilter {
	scope?: string;
	type?: string;
	/** Include superseded and retired memories (history). */
	includeInactive?: boolean;
	limit?: number;
	/** `nextCursor` of a previous page: the page continues after it. */
	cursor?: string;
	/** Rows to skip before the page (offset paging). */
	offset?: number;
}

const SCOPE = /^(user|global|skill:[a-z0-9]+(-[a-z0-9]+)*)$/;

export function isMemoryScope(value: unknown): value is string {
	return typeof value === "string" && SCOPE.test(value);
}

export function isMemoryType(value: unknown): value is MemoryType {
	return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

function decode(row: Record<string, unknown>): MemoryRow {
	const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
	return {
		id: String(row.id),
		scope: String(row.scope),
		type: row.type as MemoryType,
		content: String(row.content),
		importance: Number(row.importance),
		source: row.source as MemorySource,
		sourceRunId: nullable(row.source_run_id),
		supersededBy: nullable(row.superseded_by),
		retiredAt: nullable(row.retired_at),
		createdAt: String(row.created_at),
		lastUsedAt: nullable(row.last_used_at),
	};
}

/** Validates a new memory and returns it redacted, with `ace` importance clamped to MAX_ACE_IMPORTANCE. Throws INVALID_REQUEST. */
function prepare(input: NewMemory, redact: Redactor): NewMemory {
	if (!isMemoryScope(input.scope)) throw invalidRequest(`scope must be user, global or skill:<name>`, { scope: input.scope });
	if (!isMemoryType(input.type)) throw invalidRequest(`type must be one of ${MEMORY_TYPES.join(", ")}`, { type: input.type });
	const content = typeof input.content === "string" ? redact(input.content.trim()) : "";
	if (!content) throw invalidRequest("memory content is empty");
	if (content.length > MAX_MEMORY_CHARS) throw invalidRequest(`memory content is longer than ${MAX_MEMORY_CHARS} characters`, { length: content.length });
	if (!Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1) {
		throw invalidRequest("importance must be a number from 0 to 1", { importance: input.importance });
	}
	const importance = input.source === "ace" ? Math.min(input.importance, MAX_ACE_IMPORTANCE) : input.importance;
	return { ...input, content, importance };
}

function insert(db: Db, memory: NewMemory, nowIso: string): MemoryRow {
	const row: MemoryRow = {
		id: newId(),
		scope: memory.scope,
		type: memory.type,
		content: memory.content,
		importance: memory.importance,
		source: memory.source,
		sourceRunId: memory.sourceRunId ?? null,
		supersededBy: null,
		retiredAt: null,
		createdAt: nowIso,
		lastUsedAt: null,
	};
	db.prepare(
		"INSERT INTO memories (id, scope, type, content, importance, source, source_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(row.id, row.scope, row.type, row.content, row.importance, row.source, row.sourceRunId, nowIso);
	return row;
}

/** Stores a memory (redacted, validated, `ace` importance clamped). Throws INVALID_REQUEST. */
export function addMemory(db: Db, input: NewMemory, redact: Redactor, nowIso: string): MemoryRow {
	return insert(db, prepare(input, redact), nowIso);
}

export function getMemory(db: Db, id: string): MemoryRow | undefined {
	const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
	return row ? decode(row) : undefined;
}

function memoryNotFound(id: string): NexoError {
	return new NexoError({ code: "NOT_FOUND", message: `Memory ${id} does not exist`, context: { id } });
}

/** The curator may change only what it wrote: human and user memories are changed by a person alone. */
function assertActorMayChange(actor: LearningActor, source: MemorySource | "human", what: string, context: Record<string, unknown>): void {
	if (actor === "ace" && source !== "ace") {
		throw new NexoError({
			code: "FORBIDDEN",
			message: `The curator cannot change ${what} written by a ${source === "human" ? "human verdict" : "user"}`,
			hint: "Only a user action (the Learning page or the nexo CLI) can change it",
			context,
		});
	}
}

/**
 * Replaces a live memory with a new one (Mem0 UPDATE): the new row is stored and the old one gets `superseded_by`;
 * nothing is deleted. The replacement keeps the old scope, type and source unless given. Throws NOT_FOUND, CONFLICT
 * (already superseded or retired), FORBIDDEN (the curator replacing a human or user memory) and INVALID_REQUEST.
 */
export function supersedeMemory(
	db: Db,
	id: string,
	replacement: Partial<NewMemory> & { content: string },
	actor: LearningActor,
	redact: Redactor,
	nowIso: string,
): MemoryRow {
	return transaction(db, () => {
		const old = getMemory(db, id);
		if (!old) throw memoryNotFound(id);
		assertActorMayChange(actor, old.source, "a memory", { id, source: old.source });
		if (old.supersededBy || old.retiredAt) {
			throw new NexoError({ code: "CONFLICT", message: `Memory ${id} is no longer active`, context: { id } });
		}
		const next = insert(
			db,
			prepare(
				{
					scope: replacement.scope ?? old.scope,
					type: replacement.type ?? old.type,
					content: replacement.content,
					importance: replacement.importance ?? old.importance,
					source: actor === "ace" ? "ace" : (replacement.source ?? "user"),
					sourceRunId: replacement.sourceRunId ?? null,
				},
				redact,
			),
			nowIso,
		);
		db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(next.id, id);
		return next;
	});
}

/** Retires a live memory (kept for history, never retrieved again). Throws NOT_FOUND, CONFLICT and FORBIDDEN as `supersedeMemory`. */
export function retireMemory(db: Db, id: string, actor: LearningActor, nowIso: string): MemoryRow {
	return transaction(db, () => {
		const old = getMemory(db, id);
		if (!old) throw memoryNotFound(id);
		assertActorMayChange(actor, old.source, "a memory", { id, source: old.source });
		if (old.supersededBy || old.retiredAt) {
			throw new NexoError({ code: "CONFLICT", message: `Memory ${id} is no longer active`, context: { id } });
		}
		db.prepare("UPDATE memories SET retired_at = ? WHERE id = ?").run(nowIso, id);
		return { ...old, retiredAt: nowIso };
	});
}

/** Memories by scope and type, newest first. Throws INVALID_REQUEST for a bad scope, type or limit. */
export function listMemories(db: Db, filter: MemoryFilter = {}): MemoryRow[] {
	return queryMemories(db, filter).memories;
}

/** One page of `listMemories`, newest first, with the cursor of the next page when there is one. */
export function queryMemories(db: Db, filter: MemoryFilter = {}): { memories: MemoryRow[]; nextCursor: string | null; total: number } {
	if (filter.scope !== undefined && !isMemoryScope(filter.scope)) throw invalidRequest("scope must be user, global or skill:<name>", { scope: filter.scope });
	if (filter.type !== undefined && !isMemoryType(filter.type)) throw invalidRequest(`type must be one of ${MEMORY_TYPES.join(", ")}`, { type: filter.type });
	const limit = checkLimit(filter.limit ?? 200, 1000);
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (!filter.includeInactive) where.push("superseded_by IS NULL AND retired_at IS NULL");
	if (filter.scope !== undefined) {
		where.push("scope = ?");
		args.push(filter.scope);
	}
	if (filter.type !== undefined) {
		where.push("type = ?");
		args.push(filter.type);
	}
	const offset = checkOffset(filter.offset);
	const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`).get(...args) as { n: number }).n);
	if (filter.cursor !== undefined) {
		const after = decodeCursor(filter.cursor);
		where.push("(created_at < ? OR (created_at = ? AND id < ?))");
		args.push(after.key, after.key, after.id);
	}
	const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
	const { items, nextCursor } = pageOf(db.prepare(sql).all(...args, limit + 1, offset).map(decode), limit, (m) => ({ key: m.createdAt, id: m.id }));
	return { memories: items, nextCursor, total };
}

/** Live memories in any of `scopes` (retrieval candidates). */
export function liveMemories(db: Db, scopes: readonly string[]): MemoryRow[] {
	if (scopes.length === 0) return [];
	const marks = scopes.map(() => "?").join(", ");
	return db
		.prepare(`SELECT * FROM memories WHERE scope IN (${marks}) AND superseded_by IS NULL AND retired_at IS NULL ORDER BY created_at, id`)
		.all(...scopes)
		.map(decode);
}

/** True when any of `scopes` has a live memory. */
export function hasLiveMemories(db: Db, scopes: readonly string[]): boolean {
	if (scopes.length === 0) return false;
	const marks = scopes.map(() => "?").join(", ");
	return db.prepare(`SELECT 1 FROM memories WHERE scope IN (${marks}) AND superseded_by IS NULL AND retired_at IS NULL LIMIT 1`).get(...scopes) !== undefined;
}

/** The chain of memories this one replaced, newest first (its history). */
export function memoryHistory(db: Db, id: string): MemoryRow[] {
	const out: MemoryRow[] = [];
	let current: string | null = id;
	for (let guard = 0; current && guard < 100; guard++) {
		const prev = db.prepare("SELECT * FROM memories WHERE superseded_by = ?").get(current);
		if (!prev) break;
		const row = decode(prev);
		out.push(row);
		current = row.id;
	}
	return out;
}

/** English function words left out of FTS queries: rare in short notes, they would outrank the words that matter. */
const STOPWORDS = new Set(
	"a an and are as at be but by can could did do does for from had has have how i if in into is it its me my no not of on or our please should so than that the their them then there these they this to us was we were what when where which who why will with would you your".split(
		" ",
	),
);

/**
 * Words of `text` as an FTS5 query: unique lowercase letter/digit runs of two or more characters that are not
 * STOPWORDS, each quoted, joined with OR. Quoting keeps FTS5 operators in the text from being parsed. Empty when the
 * text has no such word.
 */
export function ftsQuery(text: string, maxTerms = 32): string {
	const words = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []))].filter((w) => !STOPWORDS.has(w)).slice(0, maxTerms);
	return words.map((w) => `"${w}"`).join(" OR ");
}

/** BM25 matches of `text` among live memories in `scopes`: memory id → BM25 score (higher is more relevant, > 0). */
export function ftsScores(db: Db, text: string, scopes: readonly string[]): Map<string, number> {
	const query = ftsQuery(text);
	if (!query || scopes.length === 0) return new Map();
	const marks = scopes.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT m.id AS id, -bm25(memories_fts) AS score FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
			 WHERE memories_fts MATCH ? AND m.scope IN (${marks}) AND m.superseded_by IS NULL AND m.retired_at IS NULL`,
		)
		.all(query, ...scopes);
	return new Map(rows.map((r) => [String(r.id), Math.max(Number(r.score), 0)]));
}

export function touchMemories(db: Db, ids: readonly string[], nowIso: string): void {
	const stmt = db.prepare("UPDATE memories SET last_used_at = ? WHERE id = ?");
	for (const id of ids) stmt.run(nowIso, id);
}

/** Encodes a vector as float32 little-endian bytes. */
export function encodeVector(vector: ArrayLike<number>): Uint8Array {
	const bytes = new Uint8Array(vector.length * 4);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, Number(vector[i]), true);
	return bytes;
}

export function decodeVector(bytes: Uint8Array): Float32Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out = new Float32Array(Math.floor(bytes.byteLength / 4));
	for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
	return out;
}

export function putEmbedding(db: Db, memoryId: string, model: string, vector: ArrayLike<number>, nowIso: string): void {
	if (vector.length === 0) throw invalidRequest("an embedding needs at least one dimension", { memoryId });
	db.prepare("INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)").run(
		memoryId,
		model,
		vector.length,
		encodeVector(vector),
		nowIso,
	);
}

/** Vectors of the given memories made by `model`; memories without one (or with another model's) are absent. */
export function getEmbeddings(db: Db, memoryIds: readonly string[], model: string): Map<string, Float32Array> {
	const out = new Map<string, Float32Array>();
	const stmt = db.prepare("SELECT vector FROM memory_embeddings WHERE memory_id = ? AND model = ?");
	for (const id of memoryIds) {
		const row = stmt.get(id, model);
		if (row) out.set(id, decodeVector(row.vector as Uint8Array));
	}
	return out;
}

/** Live memories without an embedding from `model`, oldest first. */
export function memoriesWithoutEmbedding(db: Db, model: string, limit: number): MemoryRow[] {
	return db
		.prepare(
			`SELECT m.* FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?
			 WHERE e.memory_id IS NULL AND m.superseded_by IS NULL AND m.retired_at IS NULL ORDER BY m.created_at, m.id LIMIT ?`,
		)
		.all(model, limit)
		.map(decode);
}
