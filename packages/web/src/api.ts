import { closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, type Stats, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, relative, sep } from "node:path";
import {
	agreementStats,
	approveOptimRun,
	checkPromotion,
	getArtifact,
	getOptimRun,
	listOptimCandidates,
	listOptimRuns,
	type OptimRunRow,
	confusionMatrix,
	COST_DIMENSIONS,
	costReport,
	type Db,
	descendantRunIds,
	getRun,
	getRunWithSummary,
	getSpan,
	invalidRequest,
	isRunStatus,
	judgeDisagrees,
	judgeHumanPairs,
	latestFeedback,
	listCalibrations,
	listChildSummaries,
	listDisagreements,
	listFeedback,
	listScores,
	listSessionSummaries,
	MAX_RUN_PAGE,
	listSpans,
	loadSpanTree,
	queryRuns,
	RUN_STATUSES,
	readRunJson,
	recordFeedback,
	type RunQuery,
	type RunRow,
	runNotFound,
	type ArtifactRow,
	countLearnJobs,
	getMemory,
	getPlaybookItem,
	isSkillName,
	listArtifactVersions,
	listLearnJobs,
	listMemories,
	listPlaybookItems,
	listPlaybookSkills,
	memoryHistory,
	type PlaybookItemRow,
	playbookItemHistory,
	publishPlaybook,
	retireMemory,
	retirePlaybookItem,
	transaction,
} from "@nexo/store";
import { NexoError, type Redactor } from "@nexo/telemetry";
import { resolveConfined } from "@nexo/tools";
import type {
	CostResponse,
	DirListing,
	Escalation,
	Feedback,
	FeedbackResponse,
	FileEntry,
	JudgeCalibrationResponse,
	LearnJobsResponse,
	MemoryDetailResponse,
	MemoryListResponse,
	MemoryRetireResponse,
	MetaResponse,
	OptimApproveResponse,
	OptimDetailResponse,
	OptimListResponse,
	OptimReport,
	OptimRunItem,
	PlaybookItem,
	PlaybookListResponse,
	PlaybookResponse,
	PlaybookRetireResponse,
	PlaybookVersion,
	ReadOnlyInfo,
	RunDetailResponse,
	RunListResponse,
	SessionListResponse,
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
	/** The configured judge and its same-family warnings; key null without a judge. */
	judge: { key: string | null; warnings: string[] };
	/** `learning.enabled` of the loaded config: verdicts then store human lessons and enqueue learn jobs. */
	learning: { enabled: boolean };
	/** `optimize.minJudgeKappa` of the loaded config, for the approval gate. */
	optimize: { minJudgeKappa: number };
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
	const query: RunQuery = {};
	const scored = optional(params, "scored");
	if (scored !== undefined) {
		if (scored !== "true" && scored !== "false") throw invalidRequest("scored must be true or false", { scored });
		query.scored = scored === "true";
	}
	const status = optional(params, "status");
	if (status !== undefined) {
		if (!isRunStatus(status)) throw invalidRequest(`Unknown status "${status}"`, { status });
		query.status = status;
	}
	const skill = optional(params, "skill");
	if (skill !== undefined) query.skill = skill;
	const session = optional(params, "session");
	if (session !== undefined) query.sessionId = session;
	const oneShot = optional(params, "oneShot");
	if (oneShot !== undefined) {
		if (oneShot !== "true" && oneShot !== "false") throw invalidRequest("oneShot must be true or false", { oneShot });
		query.oneShot = oneShot === "true";
	}
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

/** `GET /api/sessions?limit=`: chat sessions, most recently updated first, with their turn aggregates. */
export function listSessionsResponse(ctx: ApiContext, params: URLSearchParams): SessionListResponse {
	const limit = intParam(params, "limit", 50);
	if (limit < 1 || limit > MAX_RUN_PAGE) throw invalidRequest(`limit must be an integer from 1 to ${MAX_RUN_PAGE}`, { limit });
	return { sessions: listSessionSummaries(ctx.db, { limit }) };
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
		scores: listScores(ctx.db, id).map(({ details: { rubric: _rubric, ...details }, ...score }) => ({ ...score, details })),
		escalations: listEscalations(ctx.db, id),
		judgeDisagrees: judgeDisagrees(ctx.db, id),
	};
}

/** The run's own `escalation` spans, oldest first. */
function listEscalations(db: Db, runId: string): Escalation[] {
	const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
	const failure = (v: unknown): { code: string; message: string } | null => {
		if (typeof v !== "object" || v === null) return null;
		const { code, message } = v as Record<string, unknown>;
		return typeof code === "string" && typeof message === "string" ? { code, message } : null;
	};
	return listSpans(db, runId)
		.filter((s) => s.kind === "escalation")
		.map((s) => ({
			spanId: s.id,
			at: s.startedAt,
			trigger: text(s.attrs.trigger) ?? s.name,
			reason: text(s.attrs.reason) ?? "",
			phase: text(s.attrs.phase) ?? "",
			applied: s.attrs.applied === true,
			blockedBy: text(s.attrs.blockedBy),
			blockedReason: text(s.attrs.blockedReason),
			from: text(s.attrs.from),
			to: text(s.attrs.to),
			continuationError: failure(s.attrs.continuationError),
		}));
}

/** Judge calibration (spec §7.4, §11): live agreement on current verdicts, stored `nexo eval judge` results and disagreements. Read-only. */
export function judgeCalibrationResponse(ctx: ApiContext): JudgeCalibrationResponse {
	const key = ctx.judge.key;
	const matrix = key === null ? null : confusionMatrix(judgeHumanPairs(ctx.db, key));
	return {
		judgeKey: key,
		warnings: ctx.judge.warnings,
		current: matrix ? { ...agreementStats(matrix), matrix } : null,
		history: listCalibrations(ctx.db, key === null ? {} : { judgeKey: key }),
		disagreements: listDisagreements(ctx.db, key === null ? {} : { judgeKey: key }),
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
	return { feedback: recordFeedback(ctx.db, { runId: id, verdict, comment, nowIso: ctx.now().toISOString(), redact: ctx.redact, learn: ctx.learning.enabled }) };
}

/** `by` defaults to day here (the CLI defaults to model); `costReport` owns the `since` default and all validation. */
export function costResponse(ctx: ApiContext, params: URLSearchParams): CostResponse {
	return costReport(ctx.db, { by: optional(params, "by") ?? "day", since: optional(params, "since"), now: ctx.now() });
}

/**
 * Media types served under their own content type so the run page can play or show them. Only formats that cannot run
 * script are listed: HTML, SVG and everything else stay `text/plain` or `application/octet-stream`.
 */
const MEDIA_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

export function mediaType(path: string): string | undefined {
	return MEDIA_TYPES[extname(path).toLowerCase()];
}

/**
 * Parses a single-range `Range` header against a file of `size` bytes. Returns null for no header or a multi-range
 * request (served whole), the inclusive byte span for a satisfiable range, or "unsatisfiable".
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
	if (header === undefined) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m) return /^bytes=[\d\s,-]+$/.test(header.trim()) && header.includes(",") ? null : "unsatisfiable";
	const [, first, last] = m as unknown as [string, string, string];
	if (first === "") {
		const suffix = Number(last);
		if (last === "" || suffix === 0 || size === 0) return "unsatisfiable";
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(first);
	const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
	if (start >= size || (last !== "" && Number(last) < start)) return "unsatisfiable";
	return { start, end };
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
 * Streams `length` bytes from offset `start` of an open regular file into a response whose status line and
 * content-length are already sent. A read error or a short read (the file shrank) destroys the connection, so the client sees a failed
 * download instead of hanging on a body that never completes; neither can crash the server.
 */
export function pipeFileRange(res: ServerResponse, fd: number, length: number, start = 0): void {
	let sent = 0;
	const stream = createReadStream("", { fd, start, end: start + length - 1, autoClose: true });
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
 * with fstat, so it cannot be swapped between the check and the read. Media files (`mediaType`) are served whole under
 * their own type with byte-range support so video can seek; every other body is `text/plain` or
 * `application/octet-stream` with a sandbox CSP, so agent-written HTML or SVG never renders as a page.
 */
export function serveRunFile(ctx: ApiContext, res: ServerResponse, id: string, relPath: string, full: boolean, range?: string): void {
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
	const media = mediaType(target);
	if (media !== undefined) {
		serveMedia(res, fd, size, media, range);
		return;
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

/**
 * Media bodies cannot run script, so they skip `sandbox`: a sandboxed media document has an opaque origin, and the
 * same-origin resource policy would then block it from loading its own file when opened in a tab.
 */
const MEDIA_CSP = "default-src 'none'; media-src 'self'; img-src 'self'";

function serveMedia(res: ServerResponse, fd: number, size: number, type: string, rangeHeader: string | undefined): void {
	const base = { ...SECURITY_HEADERS, "content-type": type, "content-security-policy": MEDIA_CSP, "cache-control": "no-store", "accept-ranges": "bytes" };
	const range = parseRange(rangeHeader, size);
	if (range === "unsatisfiable") {
		closeSync(fd);
		res.writeHead(416, { ...base, "content-range": `bytes */${size}`, "content-length": 0 });
		res.end();
		return;
	}
	const start = range?.start ?? 0;
	const length = range ? range.end - range.start + 1 : size;
	res.writeHead(range ? 206 : 200, { ...base, "content-length": length, ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${size}` } : {}) });
	if (length === 0) {
		closeSync(fd);
		res.end();
		return;
	}
	pipeFileRange(res, fd, length, start);
}

function intParam(params: URLSearchParams, name: string, fallback: number): number {
	const raw = optional(params, name);
	if (raw === undefined) return fallback;
	const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isInteger(value)) throw invalidRequest(`${name} must be a positive integer`, { [name]: raw });
	return value;
}

/** `GET /api/memories?scope=&type=&all=1&limit=`: live memories (all with `all=1`), newest first. */
export function memoriesResponse(ctx: ApiContext, params: URLSearchParams): MemoryListResponse {
	return {
		memories: listMemories(ctx.db, {
			scope: optional(params, "scope"),
			type: optional(params, "type"),
			includeInactive: params.get("all") === "1",
			limit: intParam(params, "limit", 200),
		}),
	};
}

export function memoryDetailResponse(ctx: ApiContext, id: string): MemoryDetailResponse {
	const memory = getMemory(ctx.db, id);
	if (!memory) throw new NexoError({ code: "NOT_FOUND", message: `Memory ${id} does not exist`, context: { id } });
	return { memory, history: memoryHistory(ctx.db, id) };
}

/** `POST /api/memories/{id}/retire`: a user action, so human and user memories can be retired too. */
export function retireMemoryResponse(ctx: ApiContext, id: string): MemoryRetireResponse {
	return { memory: retireMemory(ctx.db, id, "user", ctx.now().toISOString()) };
}

function skillParam(name: string): string {
	if (!isSkillName(name)) throw invalidRequest("The playbook name must be a skill name", { name });
	return name;
}

function versionView(a: ArtifactRow): PlaybookVersion {
	return { id: a.id, version: a.version, origin: a.origin, status: a.status, createdAt: a.createdAt };
}

function itemView(ctx: ApiContext, item: PlaybookItemRow): PlaybookItem {
	return { ...item, history: playbookItemHistory(ctx.db, item.id) };
}

/** `GET /api/playbooks`: every skill with playbook items, with its active item count and version. */
export function playbooksResponse(ctx: ApiContext): PlaybookListResponse {
	return {
		playbooks: listPlaybookSkills(ctx.db).map((skill) => {
			const active = listArtifactVersions(ctx.db, "playbook", skill).find((a) => a.status === "active");
			return { skill, activeItems: listPlaybookItems(ctx.db, skill).length, version: active?.version ?? null, origin: active?.origin ?? null };
		}),
	};
}

/** `GET /api/playbooks/{name}?all=1`: the items (retired ones with `all=1`) with their history, and every version. */
export function playbookResponse(ctx: ApiContext, name: string, params: URLSearchParams): PlaybookResponse {
	const skill = skillParam(name);
	return {
		skill,
		items: listPlaybookItems(ctx.db, skill, { includeRetired: params.get("all") === "1" }).map((i) => itemView(ctx, i)),
		versions: listArtifactVersions(ctx.db, "playbook", skill).map(versionView),
	};
}

/** `POST /api/playbooks/{name}/items/{key}/retire`: a user action; publishes a manual playbook version. */
export function retirePlaybookItemResponse(ctx: ApiContext, name: string, key: string): PlaybookRetireResponse {
	const skill = skillParam(name);
	const nowIso = ctx.now().toISOString();
	const version = transaction(ctx.db, () => {
		retirePlaybookItem(ctx.db, skill, key, "user", nowIso);
		return publishPlaybook(ctx.db, skill, "manual", nowIso);
	});
	const item = getPlaybookItem(ctx.db, skill, key) as PlaybookItemRow;
	return { item: itemView(ctx, item), version: version ? versionView(version) : null };
}

function optimItem(ctx: ApiContext, run: OptimRunRow): OptimRunItem {
	return {
		...run,
		baseVersion: getArtifact(ctx.db, run.baseArtifactId)?.version ?? null,
		bestVersion: run.bestArtifactId ? (getArtifact(ctx.db, run.bestArtifactId)?.version ?? null) : null,
	};
}

function requireOptimRun(ctx: ApiContext, id: string): OptimRunRow {
	const run = getOptimRun(ctx.db, id);
	if (!run) throw new NexoError({ code: "NOT_FOUND", message: `Optimization ${id} does not exist`, context: { optimRunId: id } });
	return run;
}

/** The optimization's report.json; null when there is none or it cannot be read. */
function readOptimReport(run: OptimRunRow): OptimReport | null {
	if (!run.reportRef) return null;
	try {
		return JSON.parse(readFileSync(join(run.dirPath, run.reportRef), "utf8")) as OptimReport;
	} catch {
		return null;
	}
}

/** `GET /api/optim`: optimizations, newest first. */
export function optimListResponse(ctx: ApiContext): OptimListResponse {
	return { runs: listOptimRuns(ctx.db, { limit: 100 }).map((run) => optimItem(ctx, run)) };
}

/** `GET /api/optim/{id}`: the optimization, its candidates (lineage), its holdout report and whether it can be approved. */
export function optimDetailResponse(ctx: ApiContext, id: string): OptimDetailResponse {
	const run = requireOptimRun(ctx, id);
	return {
		run: optimItem(ctx, run),
		candidates: listOptimCandidates(ctx.db, id).map((c) => {
			const artifact = getArtifact(ctx.db, c.artifactId);
			return { ...c, version: artifact?.version ?? null, artifactStatus: artifact?.status ?? null };
		}),
		report: readOptimReport(run),
		promotion: checkPromotion(ctx.db, run, ctx.optimize.minJudgeKappa),
	};
}

/** `POST /api/optim/{id}/approve`: a user action; refused with 409 (state) or 403 (judge-only evidence with low κ). */
export function approveOptimResponse(ctx: ApiContext, id: string): OptimApproveResponse {
	requireOptimRun(ctx, id);
	const { promoted, replaced } = approveOptimRun(ctx.db, id, { minJudgeKappa: ctx.optimize.minJudgeKappa, nowIso: ctx.now().toISOString() });
	return { promoted: versionView(promoted), replaced: replaced ? versionView(replaced) : null, run: optimItem(ctx, requireOptimRun(ctx, id)) };
}

/** `GET /api/learn/jobs?status=&limit=`: job counts by status and the newest jobs. */
export function learnJobsResponse(ctx: ApiContext, params: URLSearchParams): LearnJobsResponse {
	const jobs = listLearnJobs(ctx.db, { status: optional(params, "status"), limit: intParam(params, "limit", 50) });
	return {
		counts: countLearnJobs(ctx.db),
		jobs: jobs.map((j) => ({ id: j.id, runId: j.runId, kind: j.kind, trigger: j.trigger, status: j.status, attempts: j.attempts, lastError: j.lastError, createdAt: j.createdAt, updatedAt: j.updatedAt })),
	};
}
