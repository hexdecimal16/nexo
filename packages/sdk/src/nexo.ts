import type { Models } from "@earendil-works/pi-ai";
import {
	type CreateSessionOptions,
	createSession,
	createSettings,
	type DeepPartial,
	type DoctorReport,
	type EngineEvent,
	type KeyStatus,
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
import { nonInteractivePrompter, type Prompter, SEARCH_PROVIDER_IDS, type SearchOutcome, type SearchProviderId, webSearch } from "@nexo/tools";
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
	/**
	 * API keys by provider id, for this instance only: model providers (`anthropic`, `google`, …) and the web search
	 * providers `brave` and `tavily`. They win over the environment and `credentials.json` and are never written to disk.
	 */
	apiKeys?: Readonly<Record<string, string>>;
	/** fetch used by web search; tests pass a fake. */
	fetch?: typeof fetch;
}

export interface NexoWebSearchOptions {
	/** Results after merging (1 to 20); defaults to `tools.webSearch.count`. */
	count?: number;
	signal?: AbortSignal;
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
	/**
	 * Searches the web directly (no model, no cost), with the same providers and merging as the agent's `web_search`
	 * tool. INVALID_REQUEST when no `brave` or `tavily` key is set. Provider failures are in `failures`.
	 */
	webSearch(query: string, options?: NexoWebSearchOptions): Promise<SearchOutcome>;
	/** Key status of the model providers in use and the web search providers; never contains key values. */
	keys(): KeyStatus[];
	/**
	 * Stores a key in `credentials.json` (mode 600) for later processes too; runs started afterwards use it. Keys passed
	 * as `apiKeys` still win. INVALID_REQUEST for an unknown provider or a malformed key.
	 */
	setKey(provider: string, apiKey: string): KeyStatus;
	/** Deletes a provider's key from `credentials.json`. */
	removeKey(provider: string): KeyStatus;
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
export function checkSetup(options: Pick<NexoOptions, "home" | "cwd" | "env" | "models" | "apiKeys"> = {}): DoctorReport {
	const env = withHome(options);
	const cwd = options.cwd ?? process.cwd();
	const paths = resolveNexoPaths(env);
	const settings = createSettings({ paths, cwd, env, models: options.models ?? nexoModels(), apiKeys: options.apiKeys });
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
		apiKeys: options.apiKeys,
		...(options.fetch ? { fetch: options.fetch } : {}),
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
		async webSearch(query, searchOptions = {}) {
			live();
			const keys = Object.fromEntries(SEARCH_PROVIDER_IDS.map((id) => [id, runtime.settings.resolveApiKey(id)])) as Partial<Record<SearchProviderId, string>>;
			try {
				return await webSearch(query, { keys, count: searchOptions.count ?? runtime.config.tools.webSearch.count, ...(options.fetch ? { fetch: options.fetch } : {}) }, searchOptions.signal);
			} catch (error) {
				if (searchOptions.signal?.aborted || error instanceof NexoError) throw error;
				// An empty query or no key: the message names `nexo settings set-key` and the environment variables.
				throw new NexoError({ code: "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error), hint: "Pass apiKeys: { brave: \"…\" } or { tavily: \"…\" } to createNexo, or call setKey" });
			}
		},
		keys() {
			return runtime.settings.keyProviders();
		},
		setKey(provider, apiKey) {
			live();
			return runtime.settings.setKey(provider, apiKey);
		},
		removeKey(provider) {
			live();
			return runtime.settings.removeKey(provider);
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
