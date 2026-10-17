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
	/** The optimization a rollout belongs to; null for ordinary runs (which are the only ones the runs list shows). */
	optimRunId: string | null;
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
	/** Runs matching the filters across every page. */
	total: number;
}

export interface SessionListItem {
	id: string;
	title: string;
	status: "active" | "closed";
	turns: number;
	costUsd: number;
	budgetUsd: number;
	createdAt: string;
	updatedAt: string;
	/** The newest turn; null before the first one is indexed. */
	lastTurn: { runId: string; status: RunStatus; startedAt: string } | null;
	/** Finished turns without a human verdict. */
	unreviewedTurns: number;
}

export interface SessionListResponse {
	sessions: SessionListItem[];
	/** Cursor of the next page, or null on the last one. */
	nextCursor: string | null;
	total: number;
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
	nextCursor: string | null;
	total: number;
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
	nextCursor: string | null;
	/** Jobs matching the status filter across every page. */
	total: number;
}

export type OptimStatus = "running" | "succeeded" | "failed" | "aborted";

/** One candidate's result on one eval case. */
export interface CaseScore {
	quality: number;
	costUsd: number;
}

export interface OptimRun {
	id: string;
	target: string;
	status: OptimStatus;
	stopReason: string | null;
	budgetUsd: number;
	budgetRollouts: number | null;
	spentUsd: number;
	rollouts: number;
	merge: boolean;
	seed: number;
	baseArtifactId: string;
	bestArtifactId: string | null;
	dirPath: string;
	reportRef: string | null;
	judgeKey: string | null;
	judgeOnly: boolean | null;
	holdoutBefore: number | null;
	holdoutAfter: number | null;
	promotion: "approved" | "rolled_back" | null;
	replacedArtifactId: string | null;
	promotedAt: string | null;
	pid: number | null;
	error: ApiErrorBody | null;
	createdAt: string;
	endedAt: string | null;
	mode: "gepa" | "climb";
	caseId: string | null;
	climbOutcome: "improved" | "golden_raised" | "no_signal" | "not_improved" | "guard_regressed" | null;
}

/** An optimization with the version numbers of its base and best candidate. */
export interface OptimRunItem extends OptimRun {
	baseVersion: number | null;
	bestVersion: number | null;
}

export interface OptimListResponse {
	runs: OptimRunItem[];
	nextCursor: string | null;
	total: number;
}

export interface OptimCandidate {
	id: string;
	optimRunId: string;
	artifactId: string;
	parentIds: string[];
	iteration: number;
	origin: "seed" | "reflect" | "merge";
	component: string | null;
	minibatch: { caseIds: string[]; parent: CaseScore[]; child: CaseScore[] } | null;
	perCase: Record<string, CaseScore>;
	meanScore: number | null;
	meanCostUsd: number | null;
	accepted: boolean;
	createdAt: string;
	/** The candidate's artifact version and status; null when the artifact is missing. */
	version: number | null;
	artifactStatus: "active" | "candidate" | "retired" | null;
}

export interface DiffLine {
	op: "same" | "add" | "del";
	text: string;
}

export interface OptimReportCase {
	caseId: string;
	input: string;
	before: CaseScore;
	after: CaseScore;
	outcome: "win" | "loss" | "tie";
}

/** report.json of an optimization (spec §8.2.5): the holdout split only. */
export interface OptimReport {
	optimRunId: string;
	target: string;
	baseArtifactId: string;
	bestArtifactId: string;
	improved: boolean;
	holdout: { cases: OptimReportCase[]; before: CaseScore; after: CaseScore; wins: number; losses: number; ties: number };
	diff: DiffLine[];
	lineage: {
		candidateId: string;
		artifactId: string;
		parentIds: string[];
		iteration: number;
		origin: "seed" | "reflect" | "merge";
		component: string | null;
		accepted: boolean;
		meanScore: number | null;
		meanCostUsd: number | null;
		minibatch: { parent: number; child: number } | null;
	}[];
	evidence: { judgeOnly: boolean; humanScored: boolean; judgeKey: string | null; kappa: number | null; minJudgeKappa: number };
	stopReason: string;
	spentUsd: number;
	rollouts: number;
	iterations: number;
	merges: number;
	mergeNote: string | null;
	climb?: { caseId: string; guardIds: string[]; outcome: string; critique: string | null; comparisons: { label: string; winner: "A" | "B" | "tie" }[] };
	createdAt: string;
}

/** Whether the best candidate may be approved now, and why not. */
export interface PromotionState {
	allowed: boolean;
	error: ApiErrorBody | null;
	kappa: number | null;
}

export interface OptimDetailResponse {
	run: OptimRunItem;
	candidates: OptimCandidate[];
	/** null while running, after an abort or failure, or when report.json is missing or unreadable. */
	report: OptimReport | null;
	promotion: PromotionState;
}

export interface OptimApproveResponse {
	promoted: PlaybookVersion;
	replaced: PlaybookVersion | null;
	run: OptimRunItem;
}

export interface EvalCaseItem {
	id: string;
	target: string;
	input: string;
	origin: "run" | "manual" | "mined";
	status: "proposed" | "active" | "dismissed";
	/** Runs in the mined cluster; 0 for cases that were not mined. */
	clusterSize: number;
	createdAt: string;
}

export interface EvalCasesResponse {
	cases: EvalCaseItem[];
}

export interface EvalCaseResponse {
	case: EvalCaseItem;
}

export interface WikiItem {
	name: string;
	pageCount: number;
	modifiedAt: string;
}

export interface WikiListResponse {
	wikis: WikiItem[];
}

export interface WikiPageItem {
	path: string;
	slug: string;
	summary?: string;
	folder?: string;
	size: number;
	modifiedAt: string;
}

export interface WikiPagesResponse {
	wiki: string;
	pages: WikiPageItem[];
}

export interface WikiPageResponse {
	wiki: string;
	path: string;
	content: string;
	summary?: string;
	size: number;
	modifiedAt: string;
}
