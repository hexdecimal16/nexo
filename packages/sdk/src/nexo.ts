import type { Models } from "@earendil-works/pi-ai";
import {
	type CreateSessionOptions,
	createSession,
	createSettings,
	type DeepPartial,
	type DoctorReport,
	type EngineEvent,
	type NexoConfig,
	nexoModels,
	resumeSession,
	type RunRequest,
	type RunResult,
	runDoctor,
	type Session,
	type SessionDeps,
} from "@nexo/core";
import { resolveNexoPaths, reviewQueue, type ReviewQueueItem, type ReviewQueueOptions } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import { nonInteractivePrompter, type Prompter } from "@nexo/tools";
import { createRuntime } from "./runtime.ts";

export interface NexoOptions {
	/** Data directory (`NEXO_HOME`); defaults to the environment's value, then ~/.nexo. */
	home?: string;
	/** Directory whose `.nexo/config.json` is the project config; defaults to `process.cwd()`. */
	cwd?: string;
	/** Config overrides applied on top of the config files. */
	config?: DeepPartial<NexoConfig>;
	/** Environment the provider keys are read from; defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Approval prompter. Default: non-interactive, which denies every `ask`, so a backend never waits on a human. */
	prompter?: Prompter;
	/** Model registry; defaults to the built-in one. Tests pass a fake provider. */
	models?: Models;
}

export interface NexoRunOptions {
	signal?: AbortSignal;
	/**
	 * Receives engine events while this run is in flight. Events are engine-wide: when several runs overlap, each
	 * listener sees the events of all of them (each event carries its `runId`).
	 */
	onEvent?: (event: EngineEvent) => void;
}

export interface Nexo {
	/** Runs one instruction. Always pass `budgetUsd`: without it the configured budget defaults apply. Errors are `NexoError`; branch on `error.code`. */
	run(request: RunRequest, options?: NexoRunOptions): Promise<RunResult>;
	/** A chat session; call `session.turn(...)` and `session.close()`. */
	createSession(options: CreateSessionOptions): Session;
	/** Reopens a session by id. NOT_FOUND for an unknown id, CONFLICT when another process has it open. */
	resumeSession(id: string): Session;
	/** Recent runs without a human verdict, worst first (failed, over budget, aborted, low score, unscored). */
	reviewQueue(options?: ReviewQueueOptions): ReviewQueueItem[];
	/** Read-only setup checks (never prints key values). */
	doctor(): DoctorReport;
	/** Closes MCP servers and the database. Close sessions first. Safe to call twice. */
	close(): Promise<void>;
}

function withHome(options: Pick<NexoOptions, "home" | "env">): NodeJS.ProcessEnv {
	const env = options.env ?? process.env;
	return options.home === undefined ? env : { ...env, NEXO_HOME: options.home };
}

/**
 * Setup checks without building a runtime, for a backend's start-up pre-flight. Works when the config is broken,
 * which is when `createNexo` would throw.
 */
export function checkSetup(options: Pick<NexoOptions, "home" | "cwd" | "env" | "models"> = {}): DoctorReport {
	const env = withHome(options);
	const cwd = options.cwd ?? process.cwd();
	const paths = resolveNexoPaths(env);
	const settings = createSettings({ paths, cwd, env, models: options.models ?? nexoModels() });
	return runDoctor({ paths, settings, env, cwd });
}

/** Builds the runtime and returns the programmatic entry point. Throws CONFIG_INVALID when the config is not usable. */
export function createNexo(options: NexoOptions = {}): Nexo {
	const env = withHome(options);
	const cwd = options.cwd ?? process.cwd();
	const prompter = options.prompter ?? nonInteractivePrompter;
	const listeners = new Set<(event: EngineEvent) => void>();
	const runtime = createRuntime({
		env,
		cwd,
		prompter,
		models: options.models,
		overrides: options.config,
		onEvent: (event) => {
			for (const listener of [...listeners]) listener(event);
		},
	});
	let closed = false;
	const live = (): void => {
		if (closed) throw new NexoError({ code: "INVALID_REQUEST", message: "This Nexo instance is closed", hint: "Create a new one with createNexo()" });
	};
	const sessionDeps = (): SessionDeps => ({
		config: runtime.config,
		configHash: runtime.configHash,
		paths: runtime.paths,
		db: runtime.db,
		models: runtime.models,
		logger: runtime.logger,
		redact: runtime.redact,
		prompter,
		skills: runtime.skills,
		resolveApiKey: runtime.settings.resolveApiKey,
		reloadConfig: () => runtime.settings.reloadConfig(),
		...(runtime.mcp ? { mcp: runtime.mcp } : {}),
	});

	return {
		async run(request, runOptions = {}) {
			live();
			const { onEvent } = runOptions;
			if (onEvent) listeners.add(onEvent);
			try {
				return await runtime.engine.run(request, runOptions.signal);
			} finally {
				if (onEvent) listeners.delete(onEvent);
			}
		},
		createSession(sessionOptions) {
			live();
			return createSession(sessionDeps(), sessionOptions);
		},
		resumeSession(id) {
			live();
			return resumeSession(sessionDeps(), id);
		},
		reviewQueue(queueOptions) {
			live();
			return reviewQueue(runtime.db, queueOptions);
		},
		doctor() {
			return runDoctor({ paths: runtime.paths, settings: runtime.settings, env, cwd });
		},
		async close() {
			if (closed) return;
			closed = true;
			try {
				await runtime.mcp?.close();
			} finally {
				runtime.db.close();
			}
		},
	};
}
