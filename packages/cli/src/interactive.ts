import { parseArgs } from "node:util";
import { createConfiguredMcpHub, createSession, createSettings, listSessions, nexoModels, projectRoots, resumeSession, type SessionDeps } from "@nexo/core";
import type { McpHub } from "@nexo/mcp";
import { EFFORTS, type Effort } from "@nexo/router";
import { BUNDLED_SKILLS_DIR, loadSkills } from "@nexo/skills";
import { ensureNexoDirs, getSessionRow, openDb, resolveNexoPaths, sessionNotFound } from "@nexo/store";
import { NexoError, toErrorPayload } from "@nexo/telemetry";
import { restoreTerminal, runInteractive, runSessionPicker, runSettingsScreen } from "@nexo/tui";
import { type CliIO, type CliOptions, type CliStdio, EXIT_SIGINT, exitCodeFor, printError, type ProcessLike, requireTerminal, usageError } from "./common.ts";
import { openLogger } from "./runtime.ts";

export interface CrashHandlerOptions {
	proc: ProcessLike;
	/** Puts the terminal back (raw mode off, cursor shown); idempotent. */
	restore: () => void;
	/** Applied to the crash text before it is printed. */
	redact?: (text: string) => string;
	stderr: CliIO["stderr"];
	exit: (code: number) => void;
}

/**
 * While the TUI owns the terminal, any way the process can end must leave it usable: a normal exit, an uncaught
 * exception and an unhandled rejection all restore it first (the last two then print the error and exit 1).
 */
export function installCrashHandlers(options: CrashHandlerOptions): () => void {
	const { proc, restore, stderr, exit } = options;
	const redact = options.redact ?? ((text: string) => text);
	const crash = (reason: unknown): void => {
		restore();
		const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
		stderr.write(`nexo crashed: ${redact(detail)}\n`);
		exit(1);
	};
	const handlers = [
		["exit", restore],
		["uncaughtException", crash],
		["unhandledRejection", crash],
	] as const;
	for (const [event, handler] of handlers) proc.on(event, handler as () => void);
	return () => {
		for (const [event, handler] of handlers) proc.off(event, handler as () => void);
	};
}

interface InteractiveArgs {
	resume: { id: string | null } | null;
	workspace?: string;
	model?: string;
	effort?: Effort;
	/** `--resume --all`: list sessions from every project instead of the current one. */
	all?: boolean;
}

/** `--resume` takes an optional id, which `parseArgs` cannot express, so it is pulled out first. */
export function parseInteractiveArgs(args: string[]): InteractiveArgs {
	const rest: string[] = [];
	let resume: InteractiveArgs["resume"] = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--resume") {
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				resume = { id: next };
				i++;
			} else resume = { id: null };
		} else if (arg.startsWith("--resume=")) {
			resume = { id: arg.slice("--resume=".length) || null };
		} else rest.push(arg);
	}
	const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { workspace: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, all: { type: "boolean" } } });
	if (values.all && !resume) throw usageError("--all applies to --resume only");
	if (positionals.length > 0) throw usageError(`Unexpected argument "${positionals[0]}"`);
	if (values.effort !== undefined && !(EFFORTS as readonly string[]).includes(values.effort)) throw usageError(`--effort must be one of ${EFFORTS.join(", ")}`);
	if (resume && (values.workspace !== undefined || values.model !== undefined || values.effort !== undefined)) {
		throw usageError("--resume reopens a session as it was; --workspace, --model and --effort apply to new sessions only");
	}
	return { resume, workspace: values.workspace, model: values.model, effort: values.effort as Effort | undefined, all: values.all === true };
}

const PICKER_LIMIT = 50;

/**
 * `nexo` and `nexo --resume [id]`: the chat. First run (no valid config) opens setup inside runInteractive.
 */
export async function interactiveCommand(args: string[], io: CliIO, options: CliOptions, stdio: CliStdio): Promise<number> {
	const parsed = parseInteractiveArgs(args);
	requireTerminal(stdio, "nexo");
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const paths = resolveNexoPaths(env);
	ensureNexoDirs(paths);
	const models = options.models ?? nexoModels();
	const settings = createSettings({ paths, cwd, env, models });
	const db = openDb(paths.db);

	let resumeId: string | null = null;
	if (parsed.resume) {
		resumeId = parsed.resume.id;
		if (resumeId === null) {
			const rows = listSessions(db, { limit: PICKER_LIMIT, ...(parsed.all ? {} : { underDir: projectRoots(cwd) }) });
			if (rows.length === 0) {
				throw new NexoError({ code: "NOT_FOUND", message: parsed.all ? "No sessions to resume" : "No sessions to resume in this project", hint: parsed.all ? "Run `nexo` to start one" : "Run `nexo --resume --all` to see sessions from every project" });
			}
			resumeId = await runSessionPicker({ sessions: rows, terminal: options.terminal, signal: options.signal });
			if (resumeId === null) return options.signal?.aborted ? EXIT_SIGINT : 0;
		}
		if (!getSessionRow(db, resumeId)) throw sessionNotFound(resumeId);
	}

	const exit = options.exit ?? (() => {});
	const finish = (code: number): number => {
		exit(code);
		return code;
	};
	const dispose = installCrashHandlers({ proc: options.proc ?? process, restore: restoreTerminal, redact: settings.redact, stderr: io.stderr, exit: options.exit ?? ((code) => process.exit(code)) });
	// Started with the first session and kept for the next ones, so a browser connection survives across turns and sessions.
	let mcp: McpHub | null | undefined;
	const buildDeps = (prompter: SessionDeps["prompter"]): SessionDeps => {
		const { config, hash } = settings.loadConfig();
		const logger = openLogger(settings, paths, "tui");
		const skills = loadSkills([BUNDLED_SKILLS_DIR, ...config.skills.dirs]);
		for (const d of skills.diagnostics) logger.warn("invalid skill skipped", { path: d.path, error: d.error });
		if (mcp === undefined) mcp = createConfiguredMcpHub(config, { cwd, logger });
		return {
			config,
			configHash: hash,
			paths,
			db,
			models,
			logger,
			redact: settings.redact,
			prompter,
			skills,
			resolveApiKey: settings.resolveApiKey,
			reloadConfig: () => settings.reloadConfig(),
			...(mcp ? { mcp } : {}),
		};
	};
	try {
		const code = await runInteractive({
			settings,
			db,
			terminal: options.terminal,
			signal: options.signal,
			openSession: (prompter) => {
				const deps = buildDeps(prompter);
				return resumeId ? resumeSession(deps, resumeId) : createSession(deps, { cwd, workspace: parsed.workspace, model: parsed.model, effort: parsed.effort });
			},
			resumeSession: (id, prompter) => resumeSession(buildDeps(prompter), id),
		});
		await mcp?.close();
		return finish(options.signal?.aborted && code === 0 ? EXIT_SIGINT : code);
	} catch (error) {
		const payload = toErrorPayload(error);
		printError(io, payload, settings.redact);
		await mcp?.close();
		return finish(exitCodeFor(payload.code));
	} finally {
		dispose();
	}
}

/** `nexo settings` with no subcommand: the same screen as `/settings`. */
export async function settingsScreenCommand(io: CliIO, options: CliOptions, stdio: CliStdio): Promise<number> {
	requireTerminal(stdio, "nexo settings");
	const env = options.env ?? process.env;
	const paths = resolveNexoPaths(env);
	ensureNexoDirs(paths);
	const settings = createSettings({ paths, cwd: options.cwd ?? process.cwd(), env, models: options.models ?? nexoModels() });
	openLogger(settings, paths, "settings");
	const dispose = installCrashHandlers({ proc: options.proc ?? process, restore: restoreTerminal, redact: settings.redact, stderr: io.stderr, exit: options.exit ?? ((code) => process.exit(code)) });
	try {
		const result = await runSettingsScreen({ settings, terminal: options.terminal, signal: options.signal });
		if (result.error) {
			printError(io, result.error, settings.redact);
			return exitCodeFor(result.error.code);
		}
		return result.completed ? 0 : 1;
	} finally {
		dispose();
	}
}
