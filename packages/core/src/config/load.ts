import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { NexoError } from "@nexo/telemetry";
import { parseScorerSpecs } from "@nexo/scorers";
import type { NexoPaths } from "@nexo/store";
import { Value } from "typebox/value";
import { ConfigSchema, DEFAULT_CONFIG, type DeepPartial, type NexoConfig } from "./schema.ts";

export interface LoadConfigOptions {
	paths: NexoPaths;
	cwd: string;
	overrides?: DeepPartial<NexoConfig>;
}

export interface LoadedConfig {
	config: NexoConfig;
	sources: string[];
	hash: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively merges plain objects; arrays and scalars from later layers replace earlier ones. */
export function deepMerge(...layers: unknown[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const layer of layers) {
		if (!isPlainObject(layer)) continue;
		for (const [key, value] of Object.entries(layer)) {
			if (value === undefined) continue;
			out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
		}
	}
	return out;
}

/** Parses a config file; CONFIG_INVALID naming the file when it is not valid JSON. */
export function readConfigFile(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (cause) {
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: `Invalid JSON in ${file}: ${(cause as Error).message}`,
			hint: "Fix the JSON syntax in that file",
			context: { file },
			cause,
		});
	}
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (isPlainObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * One message per JSON path. typebox reports a missing property on its parent (`instancePath: ""`,
 * `params.requiredProperties`) and an unknown key as a `boolean` error on the key itself; both are rewritten here
 * so every message names the exact path the user has to fix.
 */
export function configErrors(config: unknown): { path: string; message: string }[] {
	const seen = new Map<string, string>();
	for (const error of Value.Errors(ConfigSchema, config)) {
		if (error.keyword === "additionalProperties") continue;
		if (error.keyword === "required") {
			const missing = (error.params as { requiredProperties?: string[] }).requiredProperties ?? [];
			for (const prop of missing) {
				const path = `${error.instancePath}/${prop}`;
				if (!seen.has(path)) seen.set(path, "is required");
			}
			continue;
		}
		const path = error.instancePath || "/";
		const message = error.keyword === "boolean" ? "is not a recognized setting" : error.message;
		if (!seen.has(path)) seen.set(path, message);
	}
	return [...seen].map(([path, message]) => ({ path, message }));
}

const MODELS_EXAMPLE = '{"models":{"s1":{"provider":"anthropic","id":"claude-haiku-5-5"},"s2":{"provider":"anthropic","id":"<model-id>"}}}';

function expandDir(dir: string, paths: NexoPaths, cwd: string): string {
	if (dir.startsWith("$NEXO_HOME")) return join(paths.home, dir.slice("$NEXO_HOME".length));
	if (dir === "~" || dir.startsWith("~/")) return join(homedir(), dir.slice(1));
	return resolve(cwd, dir);
}

/** `file:<path>` with the path made absolute (like skill dirs); `artifact:…` unchanged. */
function expandFileSource(source: string, paths: NexoPaths, cwd: string): string {
	return source.startsWith("file:") ? `file:${expandDir(source.slice("file:".length), paths, cwd)}` : source;
}

/**
 * A `file:` source from the project config (a cloned repo): relative to the project root only, no `~` or `$NEXO_HOME`,
 * and the real path must stay inside the project root, so a repo cannot point nexo at credentials or other files.
 */
function projectFileSource(source: string, key: string, cwd: string): string {
	if (!source.startsWith("file:")) return source;
	const requested = source.slice("file:".length);
	const refuse = (why: string): never => {
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: `Invalid configuration:\n  ${key} ${why}`,
			hint: `A ./.nexo/config.json file: source must be a file inside the project directory; set ${key} in ~/.nexo/config.json to use a file elsewhere`,
			context: { key },
		});
	};
	if (requested.startsWith("~") || requested.startsWith("$")) return refuse("must not use ~ or $NEXO_HOME in a project config");
	let real: string;
	try {
		real = realpathSync(resolve(cwd, requested));
	} catch {
		return refuse("does not name an existing file");
	}
	const rel = relative(realpathSync(cwd), real);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return refuse("points outside the project directory");
	return `file:${real}`;
}

function definesKey(layer: unknown, section: "scoring" | "router", key: string): boolean {
	if (typeof layer !== "object" || layer === null) return false;
	const value = (layer as Record<string, unknown>)[section];
	return typeof value === "object" && value !== null && key in value;
}

/** True when the project config supplies `section.key` and no CLI override replaces it. */
function fromProject(projectLayer: unknown, overrides: unknown, section: "scoring" | "router", key: string): boolean {
	return definesKey(projectLayer, section, key) && !definesKey(overrides, section, key);
}

/** An llm_judge scorer needs a judge model; throws CONFIG_INVALID naming the first such entry. */
function assertJudgeConfigured(config: NexoConfig): void {
	const index = config.scoring.scorers.findIndex((s) => s.kind === "llm_judge");
	if (index < 0 || (config.models.judge ?? []).length > 0) return;
	const path = `/scoring/scorers/${index}`;
	throw new NexoError({
		code: "CONFIG_INVALID",
		message: `Invalid configuration:\n  ${path} is an llm_judge scorer, but models.judge is not set`,
		hint: 'Set models.judge, for example [{"provider":"google","id":"<model-id>"}], or remove the llm_judge scorer',
		context: { path },
	});
}

/**
 * The tool policy of the user-level layers only: defaults, `~/.nexo/config.json` and CLI overrides, without
 * `./.nexo/config.json`. Throws CONFIG_INVALID when those layers' tools section is invalid on its own.
 */
function userToolPolicy(homeLayer: unknown, overrides: unknown, homeFile: string): NonNullable<NexoConfig["scoring"]["scorerTools"]> {
	const section = (layer: unknown) => (isPlainObject(layer) ? layer.tools : undefined);
	const tools = structuredClone(deepMerge(DEFAULT_CONFIG.tools, section(homeLayer), section(overrides)));
	if (!Value.Check(ConfigSchema.properties.tools, tools)) {
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: "Invalid configuration:\n  /tools is invalid in the user-level config",
			hint: `Fix tools in ${homeFile}`,
			context: { path: "/tools" },
		});
	}
	return { policy: tools.policy, rules: tools.rules, nonInteractiveAsk: tools.nonInteractiveAsk };
}

/** The project config file of a working directory. */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ".nexo", "config.json");
}

/** Loads `~/.nexo/config.json`, then `./.nexo/config.json`, then overrides, on top of DEFAULT_CONFIG, and validates the result. */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
	const projectFile = projectConfigPath(options.cwd);
	const sources = [options.paths.config, projectFile].filter((f) => existsSync(f));
	const layers = sources.map(readConfigFile);
	const merged = structuredClone(deepMerge(DEFAULT_CONFIG, ...layers, options.overrides));

	if (!Value.Check(ConfigSchema, merged)) {
		const errors = configErrors(merged);
		const hint =
			merged.models === undefined
				? `No models are configured. Create ${options.paths.config} defining /models/s1 and /models/s2, for example ${MODELS_EXAMPLE}`
				: `Fix the listed fields in ${options.paths.config} (or ${projectFile})`;
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: `Invalid configuration:\n${errors.map((e) => `  ${e.path} ${e.message}`).join("\n")}`,
			hint,
			context: { errors, sources },
		});
	}

	const hashed = structuredClone(merged);
	delete (hashed.scoring as { scorersOrigin?: unknown }).scorersOrigin;
	delete (hashed.scoring as { scorerTools?: unknown }).scorerTools;
	const hash = createHash("sha256").update(stableStringify(hashed)).digest("hex").slice(0, 16);
	const config = merged as NexoConfig;
	parseScorerSpecs(config.scoring.scorers, "/scoring/scorers");
	assertJudgeConfigured(config);
	// Values from ./.nexo/config.json come from a file in the working directory (a cloned repo), so they are marked or confined.
	const projectLayer = sources.includes(projectFile) ? layers[sources.indexOf(projectFile)] : undefined;
	config.scoring.scorersOrigin = fromProject(projectLayer, options.overrides, "scoring", "scorers") ? "project" : "user";
	config.scoring.scorerTools = userToolPolicy(sources.includes(options.paths.config) ? layers[sources.indexOf(options.paths.config)] : undefined, options.overrides, options.paths.config);
	config.skills.dirs = config.skills.dirs.map((d) => expandDir(d, options.paths, options.cwd));
	config.router.policy = fromProject(projectLayer, options.overrides, "router", "policy")
		? projectFileSource(config.router.policy, "/router/policy", options.cwd)
		: expandFileSource(config.router.policy, options.paths, options.cwd);
	config.scoring.rubric = fromProject(projectLayer, options.overrides, "scoring", "rubric")
		? projectFileSource(config.scoring.rubric, "/scoring/rubric", options.cwd)
		: expandFileSource(config.scoring.rubric, options.paths, options.cwd);
	return { config, sources, hash };
}
