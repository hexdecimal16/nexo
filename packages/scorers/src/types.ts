export type ScorerKind = "deterministic" | "judge" | "human";

/** One step of a run, compacted for scorers: tool calls with their arguments, errors and files touched. */
export interface SpanSummary {
	kind: string;
	name: string;
	status: "ok" | "error" | "running";
	/** Short, redacted description: tool arguments, or the model of an LLM call. */
	detail: string;
	/** Error text of a failed step. */
	error?: string;
	/** Workspace-relative file written or edited by this step. */
	file?: string;
}

/** Spec §7.4 ScoreInput, plus the workspace the run wrote to (command scorers run there). */
export interface ScoreInput {
	runId: string;
	instruction: string;
	finalOutput: string;
	runDir: string;
	workspace: string;
	trajectory: SpanSummary[];
	reference?: string;
	rubric?: string;
}

export interface ScoreCriterionResult {
	name: string;
	passed: boolean;
	note: string;
}

/** Spec §7.4 ScoreResult. `details` and `files` are nexo additions stored with the score and under `scores/`. */
export interface ScoreResult {
	value: number;
	passed: boolean;
	rationale: string;
	costUsd: number;
	criteria?: ScoreCriterionResult[];
	/** Small structured facts kept in the scores row (judge votes, exit code). */
	details?: Record<string, unknown>;
	/** Larger outputs written to `scores/<name>` in the run directory (judge responses, command logs). */
	files?: Record<string, string>;
	costUnknown?: boolean;
	/** The judge model key for judge scores. */
	model?: string;
}

export interface Scorer {
	name: string;
	kind: ScorerKind;
	/** The spec kind: command, json_schema, regex, contains, llm_judge or human. */
	type: string;
	/** Throws NexoError SCORER_FAILED when no verdict can be produced. */
	score(input: ScoreInput, signal: AbortSignal): Promise<ScoreResult>;
}
