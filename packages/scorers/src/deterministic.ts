import { NexoError } from "@nexo/telemetry";
import { Value } from "typebox/value";
import type { Scorer, ScoreResult } from "./types.ts";

/** Command output kept per scorer run, in characters; the log file keeps the head up to this size. */
export const MAX_COMMAND_OUTPUT_CHARS = 256 * 1024;
/** Characters of the output tail used as the rationale. */
export const RATIONALE_TAIL_CHARS = 2000;
/** Characters of the final output that `regex` and `contains` scorers look at. */
export const MAX_MATCHED_OUTPUT_CHARS = 1024 * 1024;

function pass(passed: boolean, rationale: string, extra: Partial<ScoreResult> = {}): ScoreResult {
	return { value: passed ? 1 : 0, passed, rationale, costUsd: 0, ...extra };
}

function tail(text: string, max: number): string {
	return text.length > max ? `…${text.slice(-max)}` : text;
}

export interface CommandRun {
	command: string;
	cwd: string;
	timeoutMs: number;
	signal: AbortSignal;
}

export interface CommandOutcome {
	/** stdout and stderr interleaved; the start error's message when `ended` is "failed". */
	output: string;
	/** Null unless `ended` is "exited". */
	exitCode: number | null;
	ended: "exited" | "timeout" | "aborted" | "failed";
}

/**
 * Runs `bash -c <command>` in its own process group and kills the group on timeout or abort. Core passes the bash tool's
 * `runBash`, which also kills the group when nexo exits; this package does not depend on `@nexo/tools`.
 */
export type CommandRunner = (run: CommandRun) => Promise<CommandOutcome>;

export interface CommandScorerOptions {
	name: string;
	command: string;
	timeoutMs: number;
	run: CommandRunner;
}

/**
 * Runs the command in the run's workspace through `run`. Exit code 0 passes; the output tail is the rationale and the
 * (capped) output is written to `scores/<name>.log`. A timeout or abort throws SCORER_FAILED: a hung check gives no verdict.
 */
export function commandScorer(options: CommandScorerOptions): Scorer {
	return {
		name: options.name,
		kind: "deterministic",
		type: "command",
		score: async (input, signal) => {
			if (signal.aborted) throw new NexoError({ code: "SCORER_FAILED", message: `Scorer ${options.name} was aborted` });
			const outcome = await options.run({ command: options.command, cwd: input.workspace, timeoutMs: options.timeoutMs, signal });
			const output = outcome.output.length > MAX_COMMAND_OUTPUT_CHARS ? outcome.output.slice(0, MAX_COMMAND_OUTPUT_CHARS) : outcome.output;
			if (outcome.ended === "failed") {
				throw new NexoError({ code: "SCORER_FAILED", message: `Command scorer ${options.name} could not start bash: ${output}` });
			}
			if (outcome.ended === "timeout" || outcome.ended === "aborted") {
				const what = outcome.ended === "timeout" ? `timed out after ${options.timeoutMs}ms` : "was aborted";
				throw new NexoError({
					code: "SCORER_FAILED",
					message: `Command scorer ${options.name} ${what}`,
					hint: outcome.ended === "timeout" ? "Raise the scorer's timeoutMs or scoring.commandTimeoutMs, or make the command finish sooner" : undefined,
					context: { command: options.command, timeoutMs: options.timeoutMs, outputTail: tail(output, 500) },
				});
			}
			const exitCode = outcome.exitCode ?? -1;
			const files = { [`${options.name}.log`]: `$ ${options.command}\n${output}` };
			return pass(exitCode === 0, `exit code ${exitCode}\n${tail(output, RATIONALE_TAIL_CHARS)}`.trimEnd(), { details: { exitCode }, files });
		},
	};
}

/** The JSON value in a final answer: the whole text, else the body of a ```json fence. */
export function extractJson(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const fence = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/i.exec(trimmed);
		if (!fence?.[1]) throw new Error("the output is not JSON and has no ```json block");
		return JSON.parse(fence[1]);
	}
}

/** Validates the final output, parsed as JSON, against a JSON Schema. */
export function jsonSchemaScorer(options: { name: string; schema: object }): Scorer {
	return {
		name: options.name,
		kind: "deterministic",
		type: "json_schema",
		score: async (input) => {
			let value: unknown;
			try {
				value = extractJson(input.finalOutput);
			} catch (error) {
				return pass(false, `Not valid JSON: ${(error as Error).message}`);
			}
			const errors = [...Value.Errors(options.schema as never, value)].slice(0, 20).map((e) => `${e.instancePath || "/"} ${e.message}`);
			return errors.length === 0 ? pass(true, "The output matches the schema") : pass(false, `Schema violations:\n${errors.join("\n")}`);
		},
	};
}

/** Passes when the pattern matches the final output (or does not, with `negate`). */
export function regexScorer(options: { name: string; pattern: string; flags?: string; negate?: boolean }): Scorer {
	const re = new RegExp(options.pattern, options.flags);
	return {
		name: options.name,
		kind: "deterministic",
		type: "regex",
		score: async (input) => {
			const matched = re.test(input.finalOutput.slice(0, MAX_MATCHED_OUTPUT_CHARS));
			const passed = options.negate ? !matched : matched;
			return pass(passed, `/${options.pattern}/${options.flags ?? ""} ${matched ? "matched" : "did not match"}${options.negate ? " (negated)" : ""}`);
		},
	};
}

/** Passes when the final output contains the text (or does not, with `negate`). */
export function containsScorer(options: { name: string; text: string; ignoreCase?: boolean; negate?: boolean }): Scorer {
	return {
		name: options.name,
		kind: "deterministic",
		type: "contains",
		score: async (input) => {
			const text = input.finalOutput.slice(0, MAX_MATCHED_OUTPUT_CHARS);
			const haystack = options.ignoreCase ? text.toLowerCase() : text;
			const needle = options.ignoreCase ? options.text.toLowerCase() : options.text;
			const found = haystack.includes(needle);
			const passed = options.negate ? !found : found;
			return pass(passed, `${JSON.stringify(options.text)} ${found ? "found" : "not found"}${options.negate ? " (negated)" : ""}`);
		},
	};
}

export interface HumanVerdictReader {
	(runId: string): { verdict: "done" | "not_done"; comment: string } | undefined;
}

/** Reads the latest human verdict (done = 1, not done = 0). Throws SCORER_FAILED when the run has no verdict yet. */
export function humanScorer(options: { name: string; readVerdict: HumanVerdictReader }): Scorer {
	return {
		name: options.name,
		kind: "human",
		type: "human",
		score: async (input) => {
			const verdict = options.readVerdict(input.runId);
			if (!verdict) {
				throw new NexoError({ code: "SCORER_FAILED", message: `Run ${input.runId} has no human verdict yet`, hint: "Review the run (CLI prompt, /done, or the web UI)" });
			}
			const done = verdict.verdict === "done";
			return pass(done, verdict.comment || (done ? "Reviewed as done" : "Reviewed as not done"));
		},
	};
}
