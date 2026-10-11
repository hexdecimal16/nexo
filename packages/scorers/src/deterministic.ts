import { Worker } from "node:worker_threads";
import { NexoError } from "@nexo/telemetry";
import { Value } from "typebox/value";
import type { Scorer, ScoreResult } from "./types.ts";

/** Command output kept per scorer run, in characters; the log file keeps the head up to this size. */
export const MAX_COMMAND_OUTPUT_CHARS = 256 * 1024;
/** Characters of the output tail used as the rationale. */
export const RATIONALE_TAIL_CHARS = 2000;
/** Longest a `regex` scorer may spend matching one output before it is stopped, in milliseconds. */
export const REGEX_TIMEOUT_MS = 1000;
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
	/** True when the runner cut the output short. */
	truncated?: boolean;
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
			const capped = outcome.output.length > MAX_COMMAND_OUTPUT_CHARS ? outcome.output.slice(0, MAX_COMMAND_OUTPUT_CHARS) : outcome.output;
			const output = outcome.truncated || capped.length < outcome.output.length ? `${capped}\n[output truncated]` : capped;
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

/** The body of the first fenced block (```json or bare) with a closing fence line, found in linear time. */
function fenceBody(text: string): string | undefined {
	let from = 0;
	for (;;) {
		const open = text.indexOf("```", from);
		if (open < 0) return undefined;
		const lineEnd = text.indexOf("\n", open);
		if (lineEnd < 0) return undefined;
		const tag = text.slice(open + 3, lineEnd).trim().toLowerCase();
		from = open + 3;
		if (tag !== "" && tag !== "json") continue;
		let pos = lineEnd + 1;
		while (pos <= text.length) {
			let end = text.indexOf("\n", pos);
			if (end < 0) end = text.length;
			if (text.slice(pos, end).trim() === "```") return text.slice(lineEnd + 1, Math.max(lineEnd + 1, pos - 1));
			pos = end + 1;
		}
		return undefined;
	}
}

/** The JSON value in a final answer: the whole text, else the body of a ```json fence. */
export function extractJson(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const body = fenceBody(trimmed);
		if (body === undefined) throw new Error("the output is not JSON and has no ```json block");
		return JSON.parse(body);
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
				value = extractJson(input.finalOutput.slice(0, MAX_MATCHED_OUTPUT_CHARS));
			} catch (error) {
				return pass(false, `Not valid JSON: ${(error as Error).message}`);
			}
			let errors: string[];
	try {
		errors = [...Value.Errors(options.schema as never, value)].slice(0, 20).map((e) => `${e.instancePath || "/"} ${e.message}`);
	} catch (cause) {
		throw new NexoError({ code: "SCORER_FAILED", message: `json_schema scorer ${options.name} cannot apply its schema: ${(cause as Error).message}`, cause });
	}
			return errors.length === 0 ? pass(true, "The output matches the schema") : pass(false, `Schema violations:\n${errors.join("\n")}`);
		},
	};
}

/** Runs one match in a worker thread so a catastrophic pattern is stopped at REGEX_TIMEOUT_MS instead of freezing the engine. */
function matchInWorker(name: string, pattern: string, flags: string | undefined, text: string, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./regex-worker.ts", import.meta.url), { workerData: { pattern, flags, text } });
		const finish = (settle: () => void) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			void worker.terminate();
			settle();
		};
		const fail = (message: string, hint?: string) => finish(() => reject(new NexoError({ code: "SCORER_FAILED", message, hint })));
		const timer = setTimeout(
			() => fail(`Regex scorer ${name} did not finish within ${REGEX_TIMEOUT_MS}ms`, "The pattern backtracks catastrophically on this output; simplify it (avoid nested quantifiers like (a+)+)"),
			REGEX_TIMEOUT_MS,
		);
		const onAbort = () => fail(`Scorer ${name} was aborted`);
		signal.addEventListener("abort", onAbort, { once: true });
		worker.once("message", (matched: boolean) => finish(() => resolve(matched)));
		worker.once("error", (error) => fail(`Regex scorer ${name} failed: ${error.message}`));
	});
}

/** Passes when the pattern matches the final output (or does not, with `negate`). The match runs in a worker with a time bound. */
export function regexScorer(options: { name: string; pattern: string; flags?: string; negate?: boolean }): Scorer {
	try {
		new RegExp(options.pattern, options.flags);
	} catch (cause) {
		throw new NexoError({ code: "CONFIG_INVALID", message: `Regex scorer ${options.name} has an invalid pattern: ${(cause as Error).message}`, context: { pattern: options.pattern, flags: options.flags }, cause });
	}
	return {
		name: options.name,
		kind: "deterministic",
		type: "regex",
		score: async (input, signal) => {
			const matched = await matchInWorker(options.name, options.pattern, options.flags, input.finalOutput.slice(0, MAX_MATCHED_OUTPUT_CHARS), signal);
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
