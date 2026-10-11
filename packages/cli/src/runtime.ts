import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createEngine, createSettings, type DeepPartial, type Engine, type EngineEvent, type NexoConfig, type Settings } from "@nexo/core";
import { loadSkills, type SkillCatalog } from "@nexo/skills";
import { type Db, ensureNexoDirs, type NexoPaths, openDb, resolveNexoPaths } from "@nexo/store";
import { createLogger, type Redactor } from "@nexo/telemetry";
import type { Prompter } from "@nexo/tools";

export interface Runtime {
	paths: NexoPaths;
	config: NexoConfig;
	db: Db;
	skills: SkillCatalog;
	engine: Engine;
	redact: Redactor;
	settings: Settings;
}

export interface RuntimeOptions {
	env: NodeJS.ProcessEnv;
	cwd: string;
	prompter: Prompter;
	models?: Models;
	overrides?: DeepPartial<NexoConfig>;
	onEvent?: (event: EngineEvent) => void;
}

export function createRuntime(options: RuntimeOptions): Runtime {
	const paths = resolveNexoPaths(options.env);
	ensureNexoDirs(paths);
	const models = options.models ?? builtinModels();
	const settings = createSettings({ paths, cwd: options.cwd, env: options.env, models, overrides: options.overrides });
	const { config, hash } = settings.loadConfig();
	const redact = settings.redact;
	const logger = createLogger({ dir: paths.logs, component: "cli", redact });
	settings.attachLogger(logger);
	const db = openDb(paths.db);
	const skills = loadSkills(config.skills.dirs);
	for (const d of skills.diagnostics) logger.warn("invalid skill skipped", { path: d.path, error: d.error });
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
	});
	return { paths, config, db, skills, engine, redact, settings };
}
