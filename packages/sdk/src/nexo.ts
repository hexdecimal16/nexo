import type { Models } from "@earendil-works/pi-ai";
import {
	type CreateSessionOptions,
	createEngine,
	createSession,
	createSettings,
	type DeepPartial,
	type DoctorReport,
	type EngineEvent,
	type KeyStatus,
	type NexoConfig,
	nexoModels,
	recentPrompts,
	resumeSession,
	type RunRequest,
	type RunResult,
	runDoctor,
	type Session,
	type SessionDeps,
	type SettingView,
} from "@nexo/core";
import { type PromptHistoryEntry, resolveNexoPaths, reviewQueue, type ReviewQueueItem, type ReviewQueueOptions } from "@nexo/store";
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
	/** When true, automatically approves all tool approval prompts without asking or calling the approver model. */
	allowAll?: boolean;
	/** Model registry; defaults to the built-in one. Tests pass a fake provider. */
	models?: Models;
	/**
	 * API keys by provider id, for this instance only: model providers (`anthropic`, `google`, …) and the web search
	 * providers `brave` and `tavily`, and `playwright-<profile>` Chrome profile tokens for the browser skill. They win over the environment and `credentials.json` and are never written to disk.
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
	/**
	 * Runs one instruction with the settings current when it starts. Always pass `budgetUsd`: without it the configured
	 * budget defaults apply. Errors are `NexoError`; branch on `error.code`.
	 */
	run(request: RunRequest, options?: NexoRunOptions): Promise<RunResult>;
	/**
	 * A chat session with the current settings, which it keeps until `session.refreshConfig()` (settings changed later
	 * apply to sessions started afterwards); call `session.turn(...)` and `session.close()`.
	 */
	createSession(options: CreateSessionOptions): Session;
	/** Reopens a session by id with the current settings. NOT_FOUND for an unknown id, CONFLICT when another process has it open. */
	resumeSession(id: string): Session;
	/** Recent runs without a human verdict, worst first (failed, over budget, aborted, low score, unscored). */
	reviewQueue(options?: ReviewQueueOptions): ReviewQueueItem[];
	/**
	 * Prompts typed in interactive `nexo` sessions (the TUI's up-arrow history, also shown by `nexo history`), oldest
	 * first. By default the last 100 from this instance's project (`cwd`); `all` covers every project.
	 */
	promptHistory(options?: { limit?: number; all?: boolean }): PromptHistoryEntry[];
	/** Read-only setup checks (never prints key values). */
	doctor(): DoctorReport;
	/**
	 * Searches the web directly (no model, no cost), with the same providers and merging as the agent's `web_search`
	 * tool. INVALID_REQUEST when no `brave` or `tavily` key is set. Provider failures are in `failures`.
	 */
	webSearch(query: string, options?: NexoWebSearchOptions): Promise<SearchOutcome>;
	/** Key status of the model providers in use, the web search providers and stored playwright-<profile> browser tokens; never contains key values. */
	keys(): KeyStatus[];
	/**
	 * Stores a key in `credentials.json` (mode 600) for later processes too; runs started afterwards use it. Keys passed
	 * as `apiKeys` still win. INVALID_REQUEST for an unknown provider or a malformed key.
	 */
	setKey(provider: string, apiKey: string): KeyStatus;
	/** Deletes a provider's key from `credentials.json`. */
	removeKey(provider: string): KeyStatus;
	/**
	 * Every editable setting with its value, source and `group`, in the same order as the TUI settings screen and
	 * `nexo settings list` (group by group, see `SETTING_GROUPS`).
	 */
	settings(): SettingView[];
	getSetting(key: string): SettingView;
	/**
	 * Writes one setting to the user config (~/.nexo/config.json) after schema validation; INVALID_REQUEST for an unknown
	 * key or a bad value. Runs and sessions started afterwards, in this process or another, use it; open sessions keep the
	 * settings they started with until `session.refreshConfig()`.
	 */
	setSetting(key: string, value: unknown): SettingView;
	/** Removes a setting from the user config, so the project config or the default applies again. */
	resetSetting(key: string): SettingView;
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
	const allowAll = options.allowAll ?? false;
	const listeners = new Set<(event: EngineEvent) => void>();
	const emit = (event: EngineEvent): void => {
		for (const listener of [...listeners]) listener(event);
	};
	const runtime = createRuntime({
		env,
		cwd,
		prompter,
		models: options.models,
		overrides: options.config,
		apiKeys: options.apiKeys,
		...(options.fetch ? { fetch: options.fetch } : {}),
		onEvent: emit,
	});
	let closed = false;
	const live = (): void => {
		if (closed) throw new NexoError({ code: "INVALID_REQUEST", message: "This Nexo instance is closed", hint: "Create a new one with createNexo()" });
	};
	/** What runs and sessions share; `config` is read when each run or session starts. */
	const depsFor = (config: NexoConfig, configHash: string) => ({
		config,
		configHash,
		paths: runtime.paths,
		db: runtime.db,
		models: runtime.models,
		logger: runtime.logger,
		redact: runtime.redact,
		prompter,
		skills: runtime.skills,
		resolveApiKey: runtime.settings.resolveApiKey,
		...(runtime.mcp ? { mcp: runtime.mcp } : {}),
	});
	// As in the TUI, a session opens with the current settings and keeps them until session.refreshConfig(); keys are
	// re-read before every turn.
	const sessionDeps = (): SessionDeps => {
		const { config, configHash } = runtime.settings.reloadConfig();
		return { ...depsFor(config, configHash), reloadConfig: () => runtime.settings.reloadConfig(), refreshKeys: () => runtime.settings.refreshKeys() };
	};
	// A run starts with the current settings too: the engine is rebuilt when the config changed since the previous run.
	// Runs in flight keep the engine they started on.
	let current = { engine: runtime.engine, configHash: runtime.configHash };
	const currentEngine = () => {
		const { config, configHash } = runtime.settings.reloadConfig();
		if (configHash !== current.configHash) {
			current = { engine: createEngine({ ...depsFor(config, configHash), onEvent: emit, ...(options.fetch ? { fetch: options.fetch } : {}) }), configHash };
		}
		return current.engine;
	};

	return {
		async run(request, runOptions = {}) {
			live();
			const engine = currentEngine();
			const { onEvent } = runOptions;
			if (onEvent) listeners.add(onEvent);
			try {
				return await engine.run(
					allowAll && request.allowAll === undefined ? { ...request, allowAll: true } : request,
					runOptions.signal,
				);
			} finally {
				if (onEvent) listeners.delete(onEvent);
			}
		},
		createSession(sessionOptions) {
			live();
			return createSession(
				sessionDeps(),
				allowAll && sessionOptions.allowAll === undefined ? { ...sessionOptions, allowAll: true } : sessionOptions,
			);
		},
		resumeSession(id) {
			live();
			return resumeSession(sessionDeps(), id);
		},
		reviewQueue(queueOptions) {
			live();
			return reviewQueue(runtime.db, queueOptions);
		},
		// Read-only, so it needs no live() check; scoped to this instance's cwd project unless `all` is set.
		promptHistory(historyOptions = {}) {
			return recentPrompts(runtime.paths, { cwd, ...historyOptions });
		},
		doctor() {
			return runDoctor({ paths: runtime.paths, settings: runtime.settings, env, cwd });
		},
		async webSearch(query, searchOptions = {}) {
			live();
			// Like a run, a search uses the keys and settings current when it starts.
			runtime.settings.refreshKeys();
			const keys = Object.fromEntries(SEARCH_PROVIDER_IDS.map((id) => [id, runtime.settings.resolveApiKey(id)])) as Partial<Record<SearchProviderId, string>>;
			try {
				return await webSearch(query, { keys, count: searchOptions.count ?? runtime.settings.loadConfig().config.tools.webSearch.count, ...(options.fetch ? { fetch: options.fetch } : {}) }, searchOptions.signal);
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
		settings() {
			return runtime.settings.settings();
		},
		getSetting(key) {
			return runtime.settings.getSetting(key);
		},
		setSetting(key, value) {
			live();
			return runtime.settings.setSetting(key, value);
		},
		resetSetting(key) {
			live();
			return runtime.settings.resetSetting(key);
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
