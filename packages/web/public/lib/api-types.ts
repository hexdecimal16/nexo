// JSON shapes of the nexo web API. The server annotates its responses with these types, so a store change that
// breaks the browser fails `npm run typecheck`. This file holds types only and is shared by browser and server.

export type RunStatus = "running" | "succeeded" | "failed" | "aborted" | "budget_exceeded";
export type Verdict = "done" | "not_done";
export type SpanStatus = "running" | "ok" | "error";
export type CostDimension = "model" | "tier" | "day" | "run" | "skill";

export interface ApiErrorBody {
	code: string;
	message: string;
	retryable: boolean;
	hint?: string | null;
	context?: Record<string, unknown>;
}

export interface RunSummary {
	id: string;
	parentRunId: string | null;
	rootRunId: string;
	instruction: string;
	skill: string | null;
	status: RunStatus;
	modelFinal: string | null;
	tierFinal: string | null;
	startedAt: string;
	endedAt: string | null;
	costUsd: number;
	costUnknown: boolean;
	tokensIn: number;
	tokensOut: number;
	childCount: number;
	verdict: Verdict | null;
	error: ApiErrorBody | null;
}

export interface RunListResponse {
	runs: RunSummary[];
	nextCursor: string | null;
}

export interface ModelInfo {
	provider: string;
	id: string;
	effort: string;
	source: string;
	role: string | null;
}

export interface HumanVerdict {
	verdict: Verdict;
	comment: string;
	createdAt: string;
}

export interface RunJsonView {
	id: string;
	instruction: string;
	skill: string | null;
	status: RunStatus;
	model: ModelInfo | null;
	startedAt: string;
	endedAt: string | null;
	costUsd: number;
	costUnknown: boolean;
	tokensIn: number;
	tokensOut: number;
	output: string;
	error: ApiErrorBody | null;
	workspace: string;
	humanVerdict?: HumanVerdict | null;
}

export interface Feedback {
	id: string;
	runId: string;
	verdict: Verdict;
	comment: string;
	createdAt: string;
}

export interface RunDetailResponse {
	run: RunSummary;
	runJson: RunJsonView | null;
	dirMissing: boolean;
	children: RunSummary[];
	feedback: Feedback[];
	/** Latest verdict of each child run that has one, keyed by child run id. */
	childFeedback: Record<string, Feedback>;
}

export interface Span {
	id: string;
	runId: string;
	parentSpanId: string | null;
	kind: string;
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

export interface SpanNode {
	span: Span;
	attrsTruncated: boolean;
	children: SpanNode[];
}

export interface SpanTreeResponse {
	roots: SpanNode[];
	total: number;
	truncated: boolean;
}

export interface SpanResponse {
	span: Span;
}

/** `symlink` entries are reported without being followed; `other` is a FIFO, socket or device, which is never served. */
export interface FileEntry {
	name: string;
	path: string;
	kind: "file" | "dir" | "symlink" | "other";
	size: number;
}

export interface DirListing {
	path: string;
	entries: FileEntry[];
}

export interface FeedbackRequest {
	verdict: Verdict;
	comment: string;
}

export interface FeedbackResponse {
	feedback: Feedback;
}

export interface CostRow {
	key: string;
	costUsd: number;
	calls: number;
	unknownCalls: number;
}

export interface CostResponse {
	by: CostDimension;
	since: string;
	rows: CostRow[];
	totalUsd: number;
	unknownCalls: number;
}

/** Set when the server refuses writes because the nexo config could not be loaded. */
export interface ReadOnlyInfo {
	message: string;
	hint: string | null;
}

export interface MetaResponse {
	runStatuses: RunStatus[];
	costDimensions: CostDimension[];
	readOnly: ReadOnlyInfo | null;
}
