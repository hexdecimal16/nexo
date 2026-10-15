import type { Models } from "@earendil-works/pi-ai";
import { createConfiguredMcpHub, createEngine, createSettings, type DeepPartial, type Engine, type EngineEvent, type LearnEvent, LearnWorker, type NexoConfig, nexoModels, type Settings } from "@nexo/core";
import type { McpHub } from "@nexo/mcp";
import { BUNDLED_SKILLS_DIR, loadSkills, type SkillCatalog } from "@nexo/skills";
import { type Db, ensureNexoDirs, type NexoPaths, openDb, resolveNexoPaths } from "@nexo/store";
import { createLogger, type Logger, type Redactor } from "@nexo/telemetry";
import type { Prompter } from "@nexo/tools";

/** The logger writes through the settings' live redactor, so keys set later in the process are redacted at once. */
export function openLogger(settings: Settings, paths: NexoPaths, component: string): Logger {
	const logger = createLogger({ dir: paths.logs, component, redact: settings.redact });
	settings.attachLogger(logger);
	return logger;
}

export interface Runtime {
	paths: NexoPaths;
	config: NexoConfig;
	db: Db;
	skills: SkillCatalog;
	engine: Engine;
	redact: Redactor;
	logger: Logger;
	settings: Settings;
	/** The configured MCP servers, null when there are none. Close it when done, or the servers keep the process alive. */
	mcp: McpHub | null;
	/** Runs pending learn jobs in this process (`nexo learn`, the drain after `nexo run`). */
	learner: LearnWorker;
}

export interface RuntimeOptions {
	env: NodeJS.ProcessEnv;
	cwd: string;
	prompter: Prompter;
	models?: Models;
	overrides?: DeepPartial<NexoConfig>;
	onEvent?: (event: EngineEvent) => void;
	/** Receives the learn worker's job events. */
	onLearnEvent?: (event: LearnEvent) => void;
}

export function createRuntime(options: RuntimeOptions): Runtime {
	const paths = resolveNexoPaths(options.env);
	ensureNexoDirs(paths);
	const models = options.models ?? nexoModels();
	const settings = createSettings({ paths, cwd: options.cwd, env: options.env, models, overrides: options.overrides });
	const { config, hash } = settings.loadConfig();
	const redact = settings.redact;
	const logger = openLogger(settings, paths, "cli");
	const db = openDb(paths.db);
	const skills = loadSkills([BUNDLED_SKILLS_DIR, ...config.skills.dirs]);
	for (const d of skills.diagnostics) logger.warn("invalid skill skipped", { path: d.path, error: d.error });
	const mcp = createConfiguredMcpHub(config, { cwd: options.cwd, logger });
	const engine = createEngine({
		config,
		configHash: hash,
		paths,
		db,
		models,
		logger,
		redact,
		prompter: options.prompter,
		skills,
		onEvent: options.onEvent,
		resolveApiKey: settings.resolveApiKey,
		...(mcp ? { mcp } : {}),
	});
	return { paths, config, db, skills, engine, redact, logger, settings, mcp, learner: new LearnWorker(engine.env, options.onLearnEvent ? { onEvent: options.onLearnEvent } : {}) };
}
