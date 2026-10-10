import { closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, type Stats, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { relative, sep } from "node:path";
import {
	COST_DIMENSIONS,
	costReport,
	type Db,
	descendantRunIds,
	getRun,
	getRunWithSummary,
	getSpan,
	invalidRequest,
	isRunStatus,
	latestFeedback,
	listChildSummaries,
	listFeedback,
	loadSpanTree,
	queryRuns,
	RUN_STATUSES,
	readRunJson,
	recordFeedback,
	type RunQuery,
	type RunRow,
	runNotFound,
} from "@nexo/store";
import { NexoError, type Redactor } from "@nexo/telemetry";
import { resolveConfined } from "@nexo/tools";
import type {
	CostResponse,
	DirListing,
	Feedback,
	FeedbackResponse,
	FileEntry,
	MetaResponse,
	ReadOnlyInfo,
	RunDetailResponse,
	RunListResponse,
	SpanResponse,
	SpanTreeResponse,
} from "../public/lib/api-types.ts";
import { SECURITY_HEADERS } from "./http-errors.ts";

/** Files larger than this are cut unless `?full=1` is passed; the response carries `x-nexo-truncated: <size>`. */
export const MAX_FILE_PREVIEW_BYTES = 1024 * 1024;

export interface ApiContext {
	db: Db;
	redact: Redactor;
	now: () => Date;
	/** Set when writes are refused because the nexo config could not be loaded. */
	readOnly: ReadOnlyInfo | null;
}

function requireRun(db: Db, id: string): RunRow {
	const run = getRun(db, id);
	if (!run) throw runNotFound(id);
	return run;
}

function optional(params: URLSearchParams, name: string): string | undefined {
	const value = params.get(name);
	return value === null || value === "" ? undefined : value;
}

/** Vocabulary and mode for the pages: the run statuses and cost dimensions to offer, and whether writes are refused. */
export function metaResponse(ctx: ApiContext): MetaResponse {
	return { runStatuses: [...RUN_STATUSES], costDimensions: [...COST_DIMENSIONS], readOnly: ctx.readOnly };
}

export function listRunsResponse(ctx: ApiContext, params: URLSearchParams): RunListResponse {
	if (optional(params, "scored") !== undefined) {
		throw invalidRequest("The scored filter is not available yet", { scored: params.get("scored") }, "Scores arrive with the scoring phase; filter by status or reviewed instead");
	}
	const query: RunQuery = {};
	const status = optional(params, "status");
	if (status !== undefined) {
		if (!isRunStatus(status)) throw invalidRequest(`Unknown status "${status}"`, { status });
		query.status = status;
	}
	const skill = optional(params, "skill");
	if (skill !== undefined) query.skill = skill;
	const reviewed = optional(params, "reviewed");
	if (reviewed !== undefined) {
		if (reviewed !== "true" && reviewed !== "false") throw invalidRequest("reviewed must be true or false", { reviewed });
		query.reviewed = reviewed === "true";
	}
	const since = optional(params, "since");
	if (since !== undefined) query.since = since;
	const limit = optional(params, "limit");
	if (limit !== undefined) query.limit = /^\d+$/.test(limit) ? Number(limit) : Number.NaN;
	const cursor = optional(params, "cursor");
	if (cursor !== undefined) query.cursor = cursor;
	return queryRuns(ctx.db, query);
}

export function runDetailResponse(ctx: ApiContext, id: string): RunDetailResponse {
	const found = getRunWithSummary(ctx.db, id);
	if (!found) throw runNotFound(id);
	const { run, summary } = found;
	const dirMissing = !existsSync(run.dirPath);
	let runJson: RunDetailResponse["runJson"] = null;
	if (!dirMissing) {
		try {
			runJson = readRunJson(run.dirPath);
		} catch {
			runJson = null;
		}
	}
	const children = listChildSummaries(ctx.db, id);
	const childFeedback: Record<string, Feedback> = {};
	for (const child of children) {
		const latest = latestFeedback(ctx.db, child.id);
		if (latest) childFeedback[child.id] = latest;
	}
	return {
		run: { ...summary, instruction: runJson?.instruction ?? run.instruction },
		runJson,
		dirMissing,
		children,
		feedback: listFeedback(ctx.db, id),
		childFeedback,
	};
}

export function spanTreeResponse(ctx: ApiContext, id: string): SpanTreeResponse {
	requireRun(ctx.db, id);
	return loadSpanTree(ctx.db, id);
}

export function spanResponse(ctx: ApiContext, id: string, spanId: string): SpanResponse {
	requireRun(ctx.db, id);
	const span = getSpan(ctx.db, spanId);
	if (!span || !descendantRunIds(ctx.db, id).includes(span.runId)) {
		throw new NexoError({ code: "NOT_FOUND", message: `Span ${spanId} is not part of run ${id}`, context: { runId: id, spanId } });
	}
	return { span };
}

/** Throws STORE_IO (retryable, a 500) when the run.json mirror cannot be written; the feedback row is kept. */
export function feedbackResponse(ctx: ApiContext, id: string, body: unknown): FeedbackResponse {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalidRequest("The request body must be a JSON object");
	const { verdict, comment } = body as { verdict?: unknown; comment?: unknown };
	return { feedback: recordFeedback(ctx.db, { runId: id, verdict, comment, nowIso: ctx.now().toISOString(), redact: ctx.redact }) };
}

/** `by` defaults to day here (the CLI defaults to model); `costReport` owns the `since` default and all validation. */
export function costResponse(ctx: ApiContext, params: URLSearchParams): CostResponse {
	return costReport(ctx.db, { by: optional(params, "by") ?? "day", since: optional(params, "since"), now: ctx.now() });
}

function looksBinary(sample: Buffer): boolean {
	return sample.includes(0);
}

function entryKind(stat: Stats): FileEntry["kind"] {
	if (stat.isSymbolicLink()) return "symlink";
	if (stat.isDirectory()) return "dir";
	return stat.isFile() ? "file" : "other";
}

/**
 * Streams the first `length` bytes of an open regular file into a response whose status line and content-length are
 * already sent. A read error or a short read (the file shrank) destroys the connection, so the client sees a failed
 * download instead of hanging on a body that never completes; neither can crash the server.
 */
export function pipeFileRange(res: ServerResponse, fd: number, length: number): void {
	let sent = 0;
	const stream = createReadStream("", { fd, start: 0, end: length - 1, autoClose: true });
	stream.on("data", (chunk) => {
		sent += chunk.length;
	});
	stream.on("error", (error) => res.destroy(error));
	stream.on("end", () => {
		if (sent < length) res.destroy(new Error(`File ended after ${sent} of ${length} bytes`));
	});
	stream.pipe(res);
}

/**
 * Serves a file or a directory listing from a run directory. Paths go through `resolveConfined`, so `..` and
 * symlinks cannot leave the run directory. Listings use lstat: a symlink is reported as `symlink` without following it.
 * Only regular files are served (a FIFO or device would block the server); the file is opened non-blocking and checked
 * with fstat, so it cannot be swapped between the check and the read. File bodies are always `text/plain` or
 * `application/octet-stream` with a sandbox CSP, so agent-written HTML never renders as a page.
 */
export function serveRunFile(ctx: ApiContext, res: ServerResponse, id: string, relPath: string, full: boolean): void {
	const run = requireRun(ctx.db, id);
	if (!existsSync(run.dirPath)) {
		throw new NexoError({
			code: "NOT_FOUND",
			message: `The directory of run ${id} no longer exists`,
			hint: "Run `nexo reindex` to drop index rows whose run directory was deleted",
			context: { runId: id, dir: run.dirPath },
		});
	}
	if (relPath.includes("\0")) throw invalidRequest("Path contains a NUL byte");
	let target: string;
	try {
		target = resolveConfined(run.dirPath, relPath === "" ? "." : relPath);
	} catch (error) {
		if (error instanceof NexoError && error.code === "TOOL_DENIED") {
			throw new NexoError({ code: "FORBIDDEN", message: `Path "${relPath}" is outside the run directory`, context: { runId: id, path: relPath } });
		}
		throw error;
	}
	let stat: Stats;
	try {
		stat = statSync(target);
	} catch {
		throw new NexoError({ code: "NOT_FOUND", message: `No file "${relPath}" in run ${id}`, context: { runId: id, path: relPath } });
	}
	const root = resolveConfined(run.dirPath, ".");
	const relOf = (abs: string) => relative(root, abs).split(sep).join("/");
	if (stat.isDirectory()) {
		const entries: FileEntry[] = [];
		for (const name of readdirSync(target)) {
			const abs = `${target}${sep}${name}`;
			try {
				const entry = lstatSync(abs);
				const kind = entryKind(entry);
				entries.push({ name, path: relOf(abs), kind, size: kind === "file" ? entry.size : 0 });
			} catch {
				continue;
			}
		}
		entries.sort((a, b) => (a.kind === "dir") === (b.kind === "dir") ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1);
		const listing: DirListing = { path: relOf(target), entries };
		const text = JSON.stringify(listing);
		res.writeHead(200, {
			...SECURITY_HEADERS,
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"content-length": Buffer.byteLength(text),
		});
		res.end(text);
		return;
	}
	const notRegular = () =>
		new NexoError({
			code: "FORBIDDEN",
			message: `"${relPath}" is not a regular file`,
			hint: "Only regular files and directories can be viewed",
			context: { runId: id, path: relPath },
		});
	if (!stat.isFile()) throw notRegular();
	let fd: number;
	try {
		fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch {
		throw new NexoError({ code: "NOT_FOUND", message: `No file "${relPath}" in run ${id}`, context: { runId: id, path: relPath } });
	}
	let size: number;
	let sample: Buffer;
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile()) throw notRegular();
		size = opened.size;
		sample = Buffer.alloc(Math.min(size, 8192));
		readSync(fd, sample, 0, sample.length, 0);
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	const truncated = !full && size > MAX_FILE_PREVIEW_BYTES;
	// The byte count is fixed when the file is opened: a file still being appended to (trajectory.jsonl of a live run)
	// is served up to that length, which keeps content-length correct.
	const length = truncated ? MAX_FILE_PREVIEW_BYTES : size;
	res.writeHead(200, {
		...SECURITY_HEADERS,
		"content-type": looksBinary(sample) ? "application/octet-stream" : "text/plain; charset=utf-8",
		"content-security-policy": "sandbox; default-src 'none'",
		"cache-control": "no-store",
		"content-length": length,
		...(truncated ? { "x-nexo-truncated": String(size) } : {}),
	});
	if (length === 0) {
		closeSync(fd);
		res.end();
		return;
	}
	pipeFileRange(res, fd, length);
}
