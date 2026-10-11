import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NexoError } from "@nexo/telemetry";
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

	const hash = createHash("sha256").update(stableStringify(merged)).digest("hex").slice(0, 16);
	const config = merged as NexoConfig;
	config.skills.dirs = config.skills.dirs.map((d) => expandDir(d, options.paths, options.cwd));
	return { config, sources, hash };
}
