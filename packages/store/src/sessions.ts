import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { NexoError, type Redactor } from "@nexo/telemetry";
import type { Db } from "./db.ts";
import { insertRow } from "./sql.ts";

export type SessionStatus = "active" | "closed";

/** `~/.nexo/sessions/{id}/session.json`: the session's state, rewritten after every change. */
export interface SessionJson {
	id: string;
	/** First user message, single line, at most 60 characters; empty until the first turn. */
	title: string;
	/** Directory `nexo` was started in. */
	cwd: string;
	/** Directory every turn works in (the cwd unless `--workspace` overrides it). */
	workspace: string;
	/** Session-level user overrides (`/model`, `/effort`); null means no override. */
	model: string | null;
	effort: string | null;
	budgetUsd: number;
	costUsd: number;
	turns: number;
	status: SessionStatus;
	createdAt: string;
	updatedAt: string;
	/** Run id of the latest turn, the target of `/done` and `/notdone`. */
	lastRunId: string | null;
	/** Size of the latest request against the model's context window, for the context gauge. */
	context: { tokens: number; window: number } | null;
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

/** Sessions, most recently updated first. */
export function listSessionRows(db: Db, options: { limit?: number } = {}): SessionRow[] {
	return db
		.prepare("SELECT * FROM sessions ORDER BY updated_at DESC, id DESC LIMIT ?")
		.all(options.limit ?? 20)
		.map(decode);
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
			appendFileSync(this.transcriptFile, lines.map((line) => `${JSON.stringify(this.redact(line))}\n`).join(""));
		} catch (cause) {
			throw new NexoError({ code: "STORE_IO", message: `Cannot append to ${this.transcriptFile}`, retryable: true, cause });
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
