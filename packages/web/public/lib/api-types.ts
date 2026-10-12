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
	/** Session link of a session turn; null for other runs. */
	sessionId: string | null;
	turnIndex: number | null;
	sessionTitle: string | null;
	/** The latest scoring round: mean value and all-passed verdict of the scorers that answered; null when never scored. */
	score: RunScore | null;
}

export interface RunScore {
	value: number | null;
	passed: boolean | null;
	scorers: number;
	failedScorers: number;
}

export interface ScoreCriterion {
	name: string;
	passed: boolean;
	note: string;
}

/** One scorer result of one scoring round (round 0 first; each S2 continuation adds a round). */
export interface Score {
	id: string;
	runId: string;
	round: number;
	scorerKind: "deterministic" | "judge" | "human";
	scorerType: string;
	scorerName: string;
	status: "ok" | "failed";
	value: number | null;
	passed: boolean | null;
	rationale: string;
	criteria: ScoreCriterion[] | null;
	details: Record<string, unknown>;
	error: ApiErrorBody | null;
	model: string | null;
	costUsd: number;
	costUnknown: boolean;
	createdAt: string;
}

/** An `escalation` span of the run: a trigger that switched to S2, or was suppressed. */
export interface Escalation {
	spanId: string;
	at: string;
	trigger: string;
	reason: string;
	phase: string;
	applied: boolean;
	blockedBy: string | null;
	/** Why a blocked trigger was suppressed. */
	blockedReason: string | null;
	from: string | null;
	to: string | null;
	/** Set when the S2 continuation failed and the previous answer was kept. */
	continuationError: { code: string; message: string } | null;
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
	/** Every score of the run, by round. */
	scores: Score[];
	escalations: Escalation[];
	/** True when the latest judge verdict and the latest human verdict disagree. */
	judgeDisagrees: boolean;
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

export interface ConfusionMatrix {
	bothPass: number;
	judgePassHumanFail: number;
	judgeFailHumanPass: number;
	bothFail: number;
}

export interface Calibration {
	id: string;
	judgeKey: string;
	cases: number;
	agreements: number;
	accuracy: number | null;
	kappa: number | null;
	matrix: ConfusionMatrix;
	createdAt: string;
}

export interface Disagreement {
	runId: string;
	instruction: string;
	judgePassed: boolean;
	verdict: Verdict;
	comment: string;
}

export interface JudgeCalibrationResponse {
	/** The configured judge (`models.judge` keys joined with `+`); null without a judge or a config. */
	judgeKey: string | null;
	/** Same-family warnings for the configured judge. */
	warnings: string[];
	/** Agreement on the current verdicts, computed for this request (not stored). */
	current: { cases: number; agreements: number; accuracy: number | null; kappa: number | null; matrix: ConfusionMatrix } | null;
	/** Stored `nexo eval judge` results for the configured judge (all judges without one), newest first. */
	history: Calibration[];
	disagreements: Disagreement[];
}
export type MemoryType = "fact" | "preference" | "lesson" | "workflow";
export type MemorySource = "ace" | "human" | "user";

export interface Memory {
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

export interface MemoryListResponse {
	memories: Memory[];
}

export interface MemoryDetailResponse {
	memory: Memory;
	/** The memories this one replaced, newest first. */
	history: Memory[];
}

export interface MemoryRetireResponse {
	memory: Memory;
}

export interface PlaybookSummary {
	skill: string;
	activeItems: number;
	version: number | null;
	origin: "manual" | "ace" | "gepa" | null;
}

export interface PlaybookListResponse {
	playbooks: PlaybookSummary[];
}

export interface PlaybookHistoryEntry {
	id: string;
	itemId: string;
	action: "add" | "update" | "retire" | "helpful" | "harmful" | "prune";
	content: string | null;
	actor: "ace" | "human" | "user";
	runId: string | null;
	createdAt: string;
}

export interface PlaybookItem {
	id: string;
	skill: string;
	key: string;
	content: string;
	helpful: number;
	harmful: number;
	source: "ace" | "human";
	status: "active" | "retired";
	sourceRunId: string | null;
	createdAt: string;
	updatedAt: string;
	history: PlaybookHistoryEntry[];
}

export interface PlaybookVersion {
	id: string;
	version: number;
	origin: "manual" | "ace" | "gepa";
	status: "active" | "candidate" | "retired";
	createdAt: string;
}

export interface PlaybookResponse {
	skill: string;
	items: PlaybookItem[];
	/** Every artifact version, newest first. */
	versions: PlaybookVersion[];
}

export interface PlaybookRetireResponse {
	item: PlaybookItem;
	version: PlaybookVersion | null;
}

export type LearnJobStatus = "pending" | "running" | "succeeded" | "failed";

export interface LearnJob {
	id: string;
	runId: string;
	kind: string;
	trigger: "run_end" | "feedback";
	status: LearnJobStatus;
	attempts: number;
	lastError: ApiErrorBody | null;
	createdAt: string;
	updatedAt: string;
}

export interface LearnJobsResponse {
	counts: Record<LearnJobStatus, number>;
	jobs: LearnJob[];
}
