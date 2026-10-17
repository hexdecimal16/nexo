import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { NexoError, type Redactor } from "@nexo/telemetry";
import { checkLimit, checkOffset, decodeCursor, pageOf } from "./cursor.ts";
import type { Db } from "./db.ts";
import type { RunStatus } from "./runs.ts";
import { insertRow } from "./sql.ts";

export type SessionStatus = "active" | "closed";

/** `~/.nexo/sessions/{id}/session.json`: the session's state, rewritten after every change. */
export interface SessionJson {
	id: string;
	/** First user message, single line, at most 60 characters; empty until the first turn. */
	title: string;
	/** Directory `nexo` was started in. */
	cwd: string;
	/**
	 * The `--workspace` directory every turn shares, or null when each turn works in its own run folder's `workspace/`,
	 * which starts as a copy of the previous turn's. Files written before run-folder sessions always hold a directory.
	 */
	workspace: string | null;
	/** Session-level user overrides (`/model`, `/effort`); null means no override. */
	model: string | null;
	effort: string | null;
	/** Effective session cap when last saved: `budgetOverrideUsd`, else `budgets.perSessionUsd`. */
	budgetUsd: number;
	/** The `/budget` override; null (or absent in older files) follows `budgets.perSessionUsd`. */
	budgetOverrideUsd?: number | null;
	costUsd: number;
	turns: number;
	status: SessionStatus;
	createdAt: string;
	updatedAt: string;
	/** Run id of the latest turn, the target of `/done` and `/notdone`. */
	lastRunId: string | null;
	/** Size of the latest request against the model's context window, for the context gauge. */
	context: { tokens: number; window: number } | null;
	/** `!` shell commands run since the last turn, sent to the model with the next message; absent in older files. */
	pendingShell?: ShellNote[];
	/** The latest turn stopped on S2 without finishing, so the next turn starts on S2; absent in older files. */
	continueOnS2?: boolean;
	/** "Always allow … this session" rules (spec: approvals §3); absent in older files. */
	sessionRules?: { tool: string; kind: "prefix" | "tool" | "host"; value?: string }[];
	/** The `/auto` override; null or absent follows `tools.autoApprove`. */
	autoApprove?: boolean | null;
}

/** A `!` shell command the user ran, as the model will read it; `output` is redacted and capped. */
export interface ShellNote {
	command: string;
	ended: "exited" | "timeout" | "aborted" | "failed";
	exitCode: number | null;
	output: string;
}

/** One line of `transcript.jsonl`. `message` is a pi `Message`, stored as JSON. */
export type TranscriptLine =
	| { type: "message"; turnIndex: number; message: unknown }
	| { type: "compaction"; turnIndex: number; summary: string; replacedThroughTurn: number };

export interface SessionRow {
	id: string;
	title: string;
	cwd: string;
	status: SessionStatus;
	budgetUsd: number;
	costUsd: number;
	turns: number;
	createdAt: string;
	updatedAt: string;
	dirPath: string;
}

const COLUMNS: Record<keyof SessionRow, string> = {
	id: "id",
	title: "title",
	cwd: "cwd",
	status: "status",
	budgetUsd: "budget_usd",
	costUsd: "cost_usd",
	turns: "turns",
	createdAt: "created_at",
	updatedAt: "updated_at",
	dirPath: "dir_path",
};

function encode(_key: string, value: unknown): SQLInputValue {
	return (value ?? null) as SQLInputValue;
}

function decode(row: Record<string, unknown>): SessionRow {
	return {
		id: String(row.id),
		title: String(row.title),
		cwd: String(row.cwd),
		status: row.status as SessionStatus,
		budgetUsd: Number(row.budget_usd),
		costUsd: Number(row.cost_usd),
		turns: Number(row.turns),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		dirPath: String(row.dir_path),
	};
}

export function sessionRowFromJson(json: SessionJson, dirPath: string): SessionRow {
	return {
		id: json.id,
		title: json.title,
		cwd: json.cwd,
		status: json.status,
		budgetUsd: json.budgetUsd,
		costUsd: json.costUsd,
		turns: json.turns,
		createdAt: json.createdAt,
		updatedAt: json.updatedAt,
		dirPath,
	};
}

/** Inserts or replaces a `sessions` row. */
export function upsertSessionRow(db: Db, row: SessionRow): void {
	insertRow(db, "sessions", COLUMNS, { ...row }, encode, true);
}

export function getSessionRow(db: Db, id: string): SessionRow | undefined {
	const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
	return row ? decode(row) : undefined;
}

/** Sessions, most recently updated first; `withTurns` leaves out sessions that never ran a turn (no recorded turn and no linked run). */
export function listSessionRows(db: Db, options: { limit?: number; withTurns?: boolean } = {}): SessionRow[] {
	const where = options.withTurns ? "WHERE turns > 0 OR EXISTS (SELECT 1 FROM runs WHERE runs.session_id = sessions.id) " : "";
	return db
		.prepare(`SELECT * FROM sessions ${where}ORDER BY updated_at DESC, id DESC LIMIT ?`)
		.all(options.limit ?? 20)
		.map(decode);
}

/** One row of the Sessions page: the session's totals plus what its turns (root runs) look like. */
export interface SessionSummary {
	id: string;
	title: string;
	status: SessionStatus;
	turns: number;
	costUsd: number;
	budgetUsd: number;
	createdAt: string;
	updatedAt: string;
	/** The newest turn; null before the first one is indexed. */
	lastTurn: { runId: string; status: RunStatus; startedAt: string } | null;
	/** Finished turns without a human verdict (the review queue's notion of unreviewed). */
	unreviewedTurns: number;
}

/**
 * Sessions that ran a turn (as `listSessionRows({ withTurns: true })`), most recently updated first, with each one's latest turn and its count of unreviewed turns. Only root runs
 * count as turns, and optimization runs never do.
 */
export function listSessionSummaries(db: Db, options: { limit?: number } = {}): SessionSummary[] {
	return querySessionSummaries(db, options).sessions;
}

/** One page of `listSessionSummaries`, newest update first; `cursor` (from a previous page) continues after its last session. */
export function querySessionSummaries(db: Db, options: { limit?: number; cursor?: string; offset?: number } = {}): { sessions: SessionSummary[]; nextCursor: string | null; total: number } {
	const limit = checkLimit(options.limit ?? 50, 200);
	const offset = checkOffset(options.offset);
	const after = options.cursor === undefined ? null : decodeCursor(options.cursor);
	const total = Number((db.prepare("SELECT COUNT(*) AS n FROM sessions s WHERE s.turns > 0 OR EXISTS (SELECT 1 FROM runs WHERE runs.session_id = s.id)").get() as { n: number }).n);
	const rows = db
		.prepare(
			`WITH turns AS (
	SELECT t.session_id, t.id, t.status, t.started_at,
		ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY t.turn_index DESC, t.started_at DESC, t.id DESC) AS recency,
		(t.status != 'running' AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.run_id = t.id)) AS is_unreviewed
	FROM runs t WHERE t.session_id IS NOT NULL AND t.parent_run_id IS NULL AND t.optim_run_id IS NULL
)
SELECT s.*, last.id AS last_id, last.status AS last_status, last.started_at AS last_started_at,
	(SELECT COUNT(*) FROM turns u WHERE u.session_id = s.id AND u.is_unreviewed) AS unreviewed
FROM sessions s LEFT JOIN turns last ON last.session_id = s.id AND last.recency = 1
WHERE (s.turns > 0 OR EXISTS (SELECT 1 FROM runs WHERE runs.session_id = s.id))${after ? " AND (s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))" : ""}
ORDER BY s.updated_at DESC, s.id DESC LIMIT ? OFFSET ?`,
		)
		.all(...(after ? [after.key, after.key, after.id] : []), limit + 1, offset);
	const summaries = rows.map((row) => {
		const session = decode(row);
		return {
			id: session.id,
			title: session.title,
			status: session.status,
			turns: session.turns,
			costUsd: session.costUsd,
			budgetUsd: session.budgetUsd,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			lastTurn: row.last_id === null ? null : { runId: String(row.last_id), status: row.last_status as RunStatus, startedAt: String(row.last_started_at) },
			unreviewedTurns: Number(row.unreviewed),
		};
	});
	const { items, nextCursor } = pageOf(summaries, limit, (s) => ({ key: s.updatedAt, id: s.id }));
	return { sessions: items, nextCursor, total };
}

export function deleteSessionRow(db: Db, id: string): void {
	db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/** Highest `turn_index` among the session's indexed runs; 0 when it has none. */
export function maxSessionTurn(db: Db, sessionId: string): number {
	const row = db.prepare("SELECT MAX(turn_index) AS t FROM runs WHERE session_id = ?").get(sessionId);
	return row?.t === null || row?.t === undefined ? 0 : Number(row.t);
}

/** The latest indexed run of a session (highest turn index), or undefined. */
export function latestSessionRunId(db: Db, sessionId: string): string | undefined {
	const row = db.prepare("SELECT id FROM runs WHERE session_id = ? ORDER BY turn_index DESC, id DESC LIMIT 1").get(sessionId);
	return row ? String(row.id) : undefined;
}

/**
 * The newest indexed turn run of the session whose run folder still has its `workspace/` folder (the files a run-folder
 * session carries into its next turn), or undefined.
 */
export function latestSessionRunWorkspace(db: Db, sessionId: string): { runId: string; dir: string } | undefined {
	const rows = db.prepare("SELECT id, dir_path FROM runs WHERE session_id = ? ORDER BY turn_index DESC, id DESC").all(sessionId);
	for (const row of rows) {
		const dir = join(String(row.dir_path), "workspace");
		if (existsSync(dir)) return { runId: String(row.id), dir };
	}
	return undefined;
}

/** Directories of the session's indexed turn runs, newest turn first. */
export function sessionRunDirs(db: Db, sessionId: string): string[] {
	return db
		.prepare("SELECT dir_path FROM runs WHERE session_id = ? ORDER BY turn_index DESC, id DESC")
		.all(sessionId)
		.map((row) => String(row.dir_path));
}

/** Keys whose values are opaque provider data (signatures, response handles) that must round-trip unchanged. */
const OPAQUE_KEYS = new Set(["thinkingSignature", "textSignature", "thoughtSignature", "responseId", "deferred"]);
const OPAQUE_MARK = "\u0000nexo-opaque:";

/**
 * Redacts `value` like `redact`, except that opaque provider fields (signatures, response ids, deferred handles and
 * image data) are kept byte for byte: altering them would make the provider reject the replayed message.
 */
export function redactPreservingOpaque<T>(redact: Redactor, value: T): T {
	const saved: unknown[] = [];
	const strip = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(strip);
		if (v === null || typeof v !== "object") return v;
		const obj = v as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(obj)) {
			const opaque = OPAQUE_KEYS.has(key) || (key === "data" && obj.type === "image");
			if (opaque && item !== undefined) {
				saved.push(item);
				out[key] = `${OPAQUE_MARK}${saved.length - 1}`;
			} else {
				out[key] = strip(item);
			}
		}
		return out;
	};
	const restore = (v: unknown): unknown => {
		if (typeof v === "string" && v.startsWith(OPAQUE_MARK)) return saved[Number(v.slice(OPAQUE_MARK.length))];
		if (Array.isArray(v)) return v.map(restore);
		if (v === null || typeof v !== "object") return v;
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(v)) out[key] = restore(item);
		return out;
	};
	return restore(redact(strip(value))) as T;
}

export function sessionNotFound(id: string): NexoError {
	return new NexoError({
		code: "NOT_FOUND",
		message: `Session ${id} does not exist`,
		hint: "List sessions with `nexo sessions`",
		context: { sessionId: id },
	});
}

/** One session's directory (`~/.nexo/sessions/{id}`). Every write is redacted. */
export class SessionDir {
	readonly id: string;
	readonly root: string;
	private readonly redact: Redactor;

	constructor(root: string, id: string, redact: Redactor) {
		this.root = root;
		this.id = id;
		this.redact = redact;
	}

	static create(sessionsRoot: string, id: string, redact: Redactor): SessionDir {
		const dir = new SessionDir(join(sessionsRoot, id), id, redact);
		try {
			mkdirSync(dir.root, { recursive: true });
		} catch (cause) {
			throw new NexoError({ code: "STORE_IO", message: `Cannot create session directory ${dir.root}`, cause });
		}
		return dir;
	}

	/** Deletes the directory and everything in it. */
	remove(): void {
		try {
			rmSync(this.root, { recursive: true, force: true });
		} catch (cause) {
			throw new NexoError({ code: "STORE_IO", message: `Cannot remove session directory ${this.root}`, cause });
		}
	}

	/** An existing session's directory; NOT_FOUND when it has no session.json. */
	static open(sessionsRoot: string, id: string, redact: Redactor): SessionDir {
		const dir = new SessionDir(join(sessionsRoot, id), id, redact);
		if (!/^[A-Za-z0-9_-]+$/.test(id) || !existsSync(dir.sessionFile)) throw sessionNotFound(id);
		return dir;
	}

	get sessionFile(): string {
		return join(this.root, "session.json");
	}

	get transcriptFile(): string {
		return join(this.root, "transcript.jsonl");
	}

	writeSessionJson(json: SessionJson): void {
		const tmp = `${this.sessionFile}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(this.redact(json), null, 2)}\n`);
			renameSync(tmp, this.sessionFile);
		} catch (cause) {
			throw new NexoError({ code: "STORE_IO", message: `Cannot write ${this.sessionFile}`, retryable: true, cause });
		}
	}

	readSessionJson(): SessionJson {
		try {
			return JSON.parse(readFileSync(this.sessionFile, "utf8")) as SessionJson;
		} catch (cause) {
			throw new NexoError({
				code: "STORE_IO",
				message: `Cannot read ${this.sessionFile}`,
				hint: "The session file is missing or not valid JSON",
				cause,
			});
		}
	}

	appendTranscript(lines: readonly TranscriptLine[]): void {
		if (lines.length === 0) return;
		try {
			const body = lines.map((line) => `${JSON.stringify(redactPreservingOpaque(this.redact, line))}\n`).join("");
			appendFileSync(this.transcriptFile, this.endsMidLine() ? `\n${body}` : body);
		} catch (cause) {
			throw new NexoError({ code: "STORE_IO", message: `Cannot append to ${this.transcriptFile}`, retryable: true, cause });
		}
	}

	/** True when the transcript is non-empty and its last byte is not a newline (a crash cut the last line short). */
	private endsMidLine(): boolean {
		if (!existsSync(this.transcriptFile)) return false;
		const size = statSync(this.transcriptFile).size;
		if (size === 0) return false;
		const fd = openSync(this.transcriptFile, "r");
		try {
			const last = Buffer.alloc(1);
			readSync(fd, last, 0, 1, size - 1);
			return last[0] !== 0x0a;
		} finally {
			closeSync(fd);
		}
	}

	/** Transcript lines in file order, skipping unparsable lines (such as a truncated last line). */
	readTranscript(): TranscriptLine[] {
		if (!existsSync(this.transcriptFile)) return [];
		const lines: TranscriptLine[] = [];
		for (const text of readFileSync(this.transcriptFile, "utf8").split("\n")) {
			if (!text.trim()) continue;
			try {
				const line = JSON.parse(text) as TranscriptLine;
				if (line && (line.type === "message" || line.type === "compaction") && typeof line.turnIndex === "number") lines.push(line);
			} catch {
				continue;
			}
		}
		return lines;
	}
}
