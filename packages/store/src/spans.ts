import type { SQLInputValue } from "node:sqlite";
import type { Db } from "./db.ts";
import { insertRow, updateById } from "./sql.ts";

export type SpanKind =
	| "run"
	| "turn"
	| "llm_call"
	| "tool_call"
	| "skill_load"
	| "subagent"
	| "escalation"
	| "judge_call"
	| "scorer"
	| "self_check"
	| "memory_read"
	| "memory_write"
	| "compaction";

export type SpanStatus = "running" | "ok" | "error";

export interface SpanRow {
	id: string;
	runId: string;
	parentSpanId: string | null;
	kind: SpanKind;
	name: string;
	status: SpanStatus;
	startedAt: string;
	endedAt: string | null;
	queuedMs: number | null;
	model: string | null;
	provider: string | null;
	tier: string | null;
	effort: string | null;
	modelSource: string | null;
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	costUnknown: boolean;
	payloadRef: string | null;
	attrs: Record<string, unknown>;
}

const COLUMNS: Record<keyof SpanRow, string> = {
	id: "id",
	runId: "run_id",
	parentSpanId: "parent_span_id",
	kind: "kind",
	name: "name",
	status: "status",
	startedAt: "started_at",
	endedAt: "ended_at",
	queuedMs: "queued_ms",
	model: "model",
	provider: "provider",
	tier: "tier",
	effort: "effort",
	modelSource: "model_source",
	tokensIn: "tokens_in",
	tokensOut: "tokens_out",
	cacheRead: "cache_read",
	cacheWrite: "cache_write",
	costUsd: "cost_usd",
	costUnknown: "cost_unknown",
	payloadRef: "payload_ref",
	attrs: "attrs_json",
};

function encode(key: string, value: unknown): SQLInputValue {
	if (key === "costUnknown") return value ? 1 : 0;
	if (key === "attrs") return JSON.stringify(value ?? {});
	return (value ?? null) as SQLInputValue;
}

function decode(row: Record<string, unknown>): SpanRow {
	const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
	return {
		id: String(row.id),
		runId: String(row.run_id),
		parentSpanId: nullable(row.parent_span_id),
		kind: row.kind as SpanKind,
		name: String(row.name),
		status: row.status as SpanStatus,
		startedAt: String(row.started_at),
		endedAt: nullable(row.ended_at),
		queuedMs: row.queued_ms === null || row.queued_ms === undefined ? null : Number(row.queued_ms),
		model: nullable(row.model),
		provider: nullable(row.provider),
		tier: nullable(row.tier),
		effort: nullable(row.effort),
		modelSource: nullable(row.model_source),
		tokensIn: Number(row.tokens_in),
		tokensOut: Number(row.tokens_out),
		cacheRead: Number(row.cache_read),
		cacheWrite: Number(row.cache_write),
		costUsd: Number(row.cost_usd),
		costUnknown: Number(row.cost_unknown) === 1,
		payloadRef: nullable(row.payload_ref),
		attrs: JSON.parse(String(row.attrs_json ?? "{}")) as Record<string, unknown>,
	};
}

export function insertSpan(db: Db, row: SpanRow): void {
	insertRow(db, "spans", COLUMNS, { ...row }, encode, true);
}

export function updateSpan(db: Db, id: string, patch: Partial<Omit<SpanRow, "id" | "runId">>): void {
	updateById(db, "spans", COLUMNS, id, patch, encode);
}

export function listSpans(db: Db, runId: string): SpanRow[] {
	return db.prepare("SELECT * FROM spans WHERE run_id = ? ORDER BY started_at, rowid").all(runId).map(decode);
}

export function getSpan(db: Db, id: string): SpanRow | undefined {
	const row = db.prepare("SELECT * FROM spans WHERE id = ?").get(id);
	return row ? decode(row) : undefined;
}

/** Spans of the given runs in start order, at most `limit`, with the total count before the limit. */
export function listSpansForRuns(db: Db, runIds: readonly string[], limit: number): { spans: SpanRow[]; total: number } {
	if (runIds.length === 0) return { spans: [], total: 0 };
	const marks = runIds.map(() => "?").join(", ");
	const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM spans WHERE run_id IN (${marks})`).get(...runIds)?.n ?? 0);
	const spans = db
		.prepare(`SELECT * FROM spans WHERE run_id IN (${marks}) ORDER BY started_at, rowid LIMIT ?`)
		.all(...runIds, limit)
		.map(decode);
	return { spans, total };
}
