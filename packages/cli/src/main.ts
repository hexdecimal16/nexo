import { parseArgs } from "node:util";
import { judgeFamilyWarnings, type RunResult } from "@nexo/core";
import { EFFORTS, type Effort } from "@nexo/router";
import { type CostReport, costReport, ensureNexoDirs, openDb, reindex, resolveNexoPaths } from "@nexo/store";
import { NexoError, toErrorPayload } from "@nexo/telemetry";
import { nonInteractivePrompter, type Prompter } from "@nexo/tools";
import { type CliIO, type CliOptions, EXIT_SIGINT, EXIT_SIGTERM, exitCodeFor, printError, USAGE, usageError } from "./common.ts";
import { evalCommand } from "./eval.ts";
import { createTtyPrompter } from "./prompter.ts";
import { createTtyLineAsker, isInteractiveTerminal, type LineAsker, promptReview } from "./review.ts";
import { createRuntime } from "./runtime.ts";
import { interactiveCommand, settingsScreenCommand } from "./interactive.ts";
import { sessionsCommand } from "./sessions.ts";
import { settingsCommand } from "./settings.ts";
import { escapeControl } from "@nexo/tui";
import { runUi } from "./ui.ts";

export { type CliIO, type CliOptions, EXIT_SIGINT, EXIT_SIGTERM, exitCodeFor };

type NexoSignal = "SIGINT" | "SIGTERM";

interface SignalSource {
	on(signal: NexoSignal, listener: () => void): unknown;
	off(signal: NexoSignal, listener: () => void): unknown;
}

/**
 * Aborts `controller` on the first SIGINT or SIGTERM and exits the process on any later one. The exit goes through
 * `exit` (process.exit by default) so exit handlers still run; `received()` names the first signal.
 */
export function abortOnSignals(
	source: SignalSource,
	controller: AbortController,
	exit: (code: number) => void = (code) => process.exit(code),
): { received: () => NexoSignal | undefined; dispose: () => void } {
	let first: NexoSignal | undefined;
	const handlers = (["SIGINT", "SIGTERM"] as const).map((name) => {
		const handler = () => {
			if (first) return exit(name === "SIGINT" ? EXIT_SIGINT : EXIT_SIGTERM);
			first = name;
			controller.abort();
		};
		source.on(name, handler);
		return [name, handler] as const;
	});
	return { received: () => first, dispose: () => handlers.forEach(([name, handler]) => source.off(name, handler)) };
}

/**
 * Ctrl-C at a prompt is consumed by readline, so it is re-raised as SIGINT and aborts the run through the same handler
 * as a Ctrl-C anywhere else.
 */
function defaultPrompter(): Prompter {
	if (!process.stdin.isTTY) return nonInteractivePrompter;
	return createTtyPrompter(process.stdin, process.stdout, { onInterrupt: () => process.kill(process.pid, "SIGINT") });
}

/** The review prompt runs only when a person is at the terminal; piped, redirected or scripted runs never block on it. */
function defaultReviewAsker(): LineAsker | null {
	if (!isInteractiveTerminal(process)) return null;
	return createTtyLineAsker(process.stdin, process.stderr);
}

/** The line printed when a run escalates to S2; the reason is model-influenced text, so it is control-escaped. */
export function escalationLine(depth: number, model: string, trigger: string, reason: string): string {
	return `\n${"  ".repeat(depth)}  ↑ escalating to ${escapeControl(model)} (${trigger}: ${escapeControl(reason)})\n`;
}

/**
 * One line per scorer of the latest scoring round, then the escalation count and how a failed S2 continuation ended.
 * Scorer and error text is model-influenced, so it is control-escaped.
 */
export function scoreLines(result: Pick<RunResult, "scores" | "escalations" | "continuationError">): string[] {
	const lines = (result.scores ?? []).map((s) => {
		const name = escapeControl(s.scorerName);
		if (s.status === "failed") return `  score ${name}: failed [${s.error?.code ?? "SCORER_FAILED"}] ${escapeControl(s.error?.message ?? "")}`.trimEnd();
		const value = s.value === null ? "–" : s.value.toFixed(2);
		const family = Array.isArray(s.details.sameFamily) && s.details.sameFamily.length > 0 ? " (same-family judge)" : "";
		return `  score ${name}: ${value} ${s.passed ? "✓ pass" : "✗ fail"}${family}`;
	});
	if (result.escalations) lines.push(`  escalated to s2 ${result.escalations === 1 ? "once" : `${result.escalations} times`}`);
	const failed = result.continuationError;
	if (failed) lines.push(`  ✗ s2 continuation failed [${escapeControl(failed.code)}] ${escapeControl(failed.message)}; kept the previous answer`);
	return lines;
}

async function runCommand(args: string[], io: CliIO, options: CliOptions): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			skill: { type: "string" },
			model: { type: "string" },
			effort: { type: "string" },
			workspace: { type: "string" },
			budget: { type: "string" },
			"no-review": { type: "boolean" },
		},
	});
	const instruction = positionals.join(" ").trim();
	if (!instruction) throw usageError("nexo run needs an instruction");
	if (values.effort !== undefined && !(EFFORTS as readonly string[]).includes(values.effort)) {
		throw usageError(`--effort must be one of ${EFFORTS.join(", ")}`);
	}
	const budgetUsd = values.budget === undefined ? undefined : Number(values.budget);
	if (budgetUsd !== undefined && !(Number.isFinite(budgetUsd) && budgetUsd > 0)) throw usageError("--budget must be a positive number of USD");

	const runtime = createRuntime({
		env: options.env ?? process.env,
		cwd: options.cwd ?? process.cwd(),
		prompter: options.prompter ?? defaultPrompter(),
		models: options.models,
		onEvent: (event) => {
			if (event.type === "text_delta" && event.depth === 0) io.stdout.write(event.delta);
			if (event.type === "run_start" && event.depth > 0) io.stderr.write(`  ↳ subagent ${event.runId.slice(-6)}: ${event.instruction.split("\n")[0]?.slice(0, 80)}\n`);
			if (event.type === "tool_start") io.stderr.write(`${"  ".repeat(event.depth)}  · ${event.toolName}\n`);
			if (event.type === "escalation" && event.applied) io.stderr.write(escalationLine(event.depth, event.model, event.trigger, event.reason));
		},
	});

	for (const warning of judgeFamilyWarnings(runtime.config)) io.stderr.write(`warning: ${escapeControl(warning)}\n`);
	const result = await runtime.engine.run(
		{
			instruction,
			skill: values.skill,
			model: values.model,
			effort: values.effort as Effort | undefined,
			workspace: values.workspace,
			budgetUsd,
		},
		options.signal,
	);
	io.stdout.write("\n");
	const mark = result.status === "succeeded" ? "✓" : "✗";
	const unknown = result.costUnknown ? " (some calls unpriced)" : "";
	io.stderr.write(`${mark} ${result.status} · $${result.costUsd.toFixed(4)}${unknown} · trajectory ${result.trajectoryId ?? "-"}${result.runDir ? ` · ${result.runDir}` : ""}\n`);
	for (const line of scoreLines(result)) io.stderr.write(`${line}\n`);
	if (result.error) printError(io, result.error);
	if (result.status === "aborted") return EXIT_SIGINT;
	const asker = values["no-review"] ? null : options.reviewAsker === undefined ? defaultReviewAsker() : options.reviewAsker;
	if (asker && result.trajectoryId) {
		if (options.signal?.aborted) return EXIT_SIGINT;
		try {
			await promptReview({ asker, db: runtime.db, runId: result.trajectoryId, redact: runtime.redact, io, signal: options.signal });
		} catch (error) {
			if (!(error instanceof NexoError)) throw error;
			printError(io, error.toPayload());
		}
		if (options.signal?.aborted) return EXIT_SIGINT;
	}
	if (result.status === "succeeded") return 0;
	return result.error ? exitCodeFor(result.error.code) : 1;
}

function costCommand(args: string[], io: CliIO, options: CliOptions): number {
	const { values } = parseArgs({ args, options: { by: { type: "string" }, since: { type: "string" } } });
	const paths = resolveNexoPaths(options.env ?? process.env);
	ensureNexoDirs(paths);
	let report: CostReport;
	try {
		report = costReport(openDb(paths.db), { by: values.by ?? "model", since: values.since });
	} catch (error) {
		if (error instanceof NexoError && error.code === "INVALID_REQUEST") throw usageError(error.message);
		throw error;
	}
	io.stdout.write(`Cost by ${report.by} since ${report.since}\n`);
	for (const r of report.rows) {
		io.stdout.write(`  ${r.key.padEnd(40)} $${r.costUsd.toFixed(4).padStart(10)}  ${r.calls} calls${r.unknownCalls ? `  (${r.unknownCalls} unpriced)` : ""}\n`);
	}
	io.stdout.write(`  ${"total".padEnd(40)} $${report.totalUsd.toFixed(4).padStart(10)}\n`);
	return 0;
}

function reindexCommand(io: CliIO, options: CliOptions): number {
	const paths = resolveNexoPaths(options.env ?? process.env);
	ensureNexoDirs(paths);
	const result = reindex(openDb(paths.db), paths.runs, paths.sessions);
	io.stdout.write(`Reindexed ${result.runs} runs, ${result.spans} spans, ${result.sessions} sessions\n`);
	for (const dir of result.skipped) io.stderr.write(`skipped unreadable directory: ${dir}\n`);
	return 0;
}

export async function runCli(argv: string[], io: CliIO, options: CliOptions = {}): Promise<number> {
	const [command, ...rest] = argv;
	const stdio = options.stdio ?? process;
	try {
		if (command === undefined || (command.startsWith("-") && command !== "--help" && command !== "-h")) {
			return await interactiveCommand(argv, io, options, stdio);
		}
		switch (command) {
			case "run":
				return await runCommand(rest, io, options);
			case "cost":
				return costCommand(rest, io, options);
			case "reindex":
				return reindexCommand(io, options);
			case "eval":
				return evalCommand(rest, io, options);
			case "sessions":
				return sessionsCommand(rest, io, options);
			case "settings":
				return rest.length === 0 ? await settingsScreenCommand(io, options, stdio) : await settingsCommand(rest, io, options, stdio);
			case "ui": {
				const { values } = parseArgs({ args: rest, options: { port: { type: "string" } } });
				return await runUi({ env: options.env ?? process.env, cwd: options.cwd ?? process.cwd(), port: values.port, io, signal: options.signal });
			}
			case "help":
			case "--help":
			case "-h":
				io.stdout.write(USAGE);
				return 0;
			default:
				throw usageError(`Unknown command "${command}"`);
		}
	} catch (error) {
		const payload = error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")
			? usageError(error.message).toPayload()
			: toErrorPayload(error);
		printError(io, payload);
		return exitCodeFor(payload.code);
	}
}
