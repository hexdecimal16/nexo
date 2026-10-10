import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createEngine, type DeepPartial, type Engine, type EngineEvent, loadConfig, type NexoConfig } from "@nexo/core";
import { loadSkills, type SkillCatalog } from "@nexo/skills";
import { type Db, ensureNexoDirs, type NexoPaths, openDb, resolveNexoPaths } from "@nexo/store";
import { createLogger, createRedactor } from "@nexo/telemetry";
import type { Prompter } from "@nexo/tools";

export interface Runtime {
	paths: NexoPaths;
	config: NexoConfig;
	db: Db;
	skills: SkillCatalog;
	engine: Engine;
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
	const { config, hash } = loadConfig({ paths, cwd: options.cwd, overrides: options.overrides });
	const redact = createRedactor(config.redaction.patterns);
	const logger = createLogger({ dir: paths.logs, component: "cli", redact });
	const db = openDb(paths.db);
	const skills = loadSkills(config.skills.dirs);
	for (const d of skills.diagnostics) logger.warn("invalid skill skipped", { path: d.path, error: d.error });
	const engine = createEngine({
		config,
		configHash: hash,
		paths,
		db,
		models: options.models ?? builtinModels(),
		logger,
		redact,
		prompter: options.prompter,
		skills,
		onEvent: options.onEvent,
	});
	return { paths, config, db, skills, engine };
}
