import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EFFORTS } from "@nexo/router";
import { NexoError } from "@nexo/telemetry";
import { configErrors, deepMerge, projectConfigPath, readConfigFile } from "../config/load.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";

/** How a setting's value is entered: a `provider/model-id` reference, one of fixed values, or a number. */
export type SettingType =
	| { kind: "model" }
	| { kind: "enum"; values: readonly string[] }
	| { kind: "number"; integer: boolean; min?: number; exclusiveMin?: number; max?: number };

export interface SettingDefinition {
	/** Dotted config path, e.g. `budgets.perRunUsd`. */
	key: string;
	label: string;
	description: string;
	type: SettingType;
}

/** Where the effective value comes from; `unset` means no layer defines it. */
export type SettingSource = "default" | "user" | "project" | "unset";

export type SettingValue = string | number | null;

export interface SettingView extends SettingDefinition {
	/** Effective value (a model as `provider/id`); null when unset. */
	value: SettingValue;
	source: SettingSource;
	/** Value in the user config, null when the user config does not set it. */
	userValue: SettingValue;
	/** The project config sets this key, so it wins over the user config. */
	overriddenByProject: boolean;
	/** `overridden by project config` when `overriddenByProject`, else null. */
	notice: string | null;
}

export const PROJECT_OVERRIDE_NOTICE = "overridden by project config";

const POLICY_VALUES = ["allow", "ask", "deny"] as const;
const USD: SettingType = { kind: "number", integer: false, exclusiveMin: 0 };

const POLICY_DESCRIPTIONS: Record<string, string> = {
	read: "read files in the workspace",
	write: "create or overwrite files in the workspace",
	edit: "edit files in the workspace",
	bash: "run shell commands",
	web_fetch: "fetch web pages",
	load_skill: "load a skill's instructions",
	spawn: "start subagents",
};

/** Every setting the settings screen and `nexo settings` can edit, in display order. */
export const EDITABLE_SETTINGS: readonly SettingDefinition[] = [
	{ key: "models.s1", label: "Model s1", description: "Default model for most work (provider/model-id)", type: { kind: "model" } },
	{ key: "models.s2", label: "Model s2", description: "Stronger model the router escalates to (provider/model-id)", type: { kind: "model" } },
	{ key: "models.s1.effort", label: "Effort s1", description: "Default reasoning effort for s1", type: { kind: "enum", values: EFFORTS } },
	{ key: "models.s2.effort", label: "Effort s2", description: "Default reasoning effort for s2", type: { kind: "enum", values: EFFORTS } },
	{ key: "budgets.perRunUsd", label: "Budget per run", description: "Spending cap for one run or turn, in USD", type: USD },
	{ key: "budgets.perSessionUsd", label: "Budget per session", description: "Spending cap for one interactive session, in USD", type: USD },
	{ key: "budgets.dailyUsd", label: "Daily budget", description: "Spending cap per UTC day, in USD", type: USD },
	{ key: "budgets.monthlyUsd", label: "Monthly budget", description: "Spending cap per UTC month, in USD", type: USD },
	...Object.keys(DEFAULT_CONFIG.tools.policy).map(
		(tool): SettingDefinition => ({
			key: `tools.policy.${tool}`,
			label: `Policy ${tool}`,
			description: `Whether the agent may ${POLICY_DESCRIPTIONS[tool] ?? `use the ${tool} tool`}: allow, ask first, or deny`,
			type: { kind: "enum", values: POLICY_VALUES },
		}),
	),
	{
		key: "tools.nonInteractiveAsk",
		label: "Ask without a terminal",
		description: "What an `ask` policy does when nobody can answer (nexo run without a TTY)",
		type: { kind: "enum", values: ["allow", "deny"] },
	},
	{
		key: "session.compactAt",
		label: "Compact at",
		description: "Share of the context window at which a session compacts older turns (0 to 1)",
		type: { kind: "number", integer: false, exclusiveMin: 0, max: 1 },
	},
	{
		key: "spawn.maxParallelSubagents",
		label: "Parallel subagents",
		description: "Most subagents one run may have working at the same time",
		type: { kind: "number", integer: true, min: 1 },
	},
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string, hint?: string, context?: Record<string, unknown>): NexoError {
	return new NexoError({ code: "INVALID_REQUEST", message, ...(hint ? { hint } : {}), ...(context ? { context } : {}) });
}

export function findSetting(key: string): SettingDefinition {
	const def = EDITABLE_SETTINGS.find((s) => s.key === key);
	if (!def) {
		throw invalidRequest(`Unknown setting "${key}"`, `Editable settings: ${EDITABLE_SETTINGS.map((s) => s.key).join(", ")}`, { key });
	}
	return def;
}

function segments(key: string): string[] {
	return key.split(".");
}

function getPath(obj: unknown, path: readonly string[]): unknown {
	let cur: unknown = obj;
	for (const seg of path) {
		if (!isPlainObject(cur)) return undefined;
		cur = cur[seg];
	}
	return cur;
}

function setPath(obj: Record<string, unknown>, path: readonly string[], value: unknown): void {
	let cur = obj;
	for (const seg of path.slice(0, -1)) {
		if (!isPlainObject(cur[seg])) cur[seg] = {};
		cur = cur[seg] as Record<string, unknown>;
	}
	cur[path[path.length - 1] as string] = value;
}

/** Deletes the leaf and then every parent object left empty. */
function deletePath(obj: Record<string, unknown>, path: readonly string[]): void {
	const parents: Record<string, unknown>[] = [obj];
	for (const seg of path.slice(0, -1)) {
		const next = parents[parents.length - 1]?.[seg];
		if (!isPlainObject(next)) return;
		parents.push(next);
	}
	delete parents[parents.length - 1]?.[path[path.length - 1] as string];
	for (let i = parents.length - 1; i > 0; i--) {
		if (Object.keys(parents[i] as object).length > 0) break;
		delete parents[i - 1]?.[path[i - 1] as string];
	}
}

/** Config paths a setting is made of: a model is its provider and id (its effort is a separate setting). */
function leafPaths(def: SettingDefinition): string[][] {
	const base = segments(def.key);
	return def.type.kind === "model" ? [[...base, "provider"], [...base, "id"]] : [base];
}

function definedIn(layer: unknown, def: SettingDefinition): boolean {
	return leafPaths(def).some((p) => getPath(layer, p) !== undefined);
}

function displayValue(def: SettingDefinition, layer: unknown): SettingValue {
	const raw = getPath(layer, segments(def.key));
	if (def.type.kind === "model") {
		if (!isPlainObject(raw)) return null;
		return typeof raw.provider === "string" && typeof raw.id === "string" ? `${raw.provider}/${raw.id}` : null;
	}
	return typeof raw === "string" || typeof raw === "number" ? raw : null;
}

/** The config layers a settings view is computed from. */
export interface ConfigLayers {
	user: Record<string, unknown>;
	project: Record<string, unknown>;
	userFile: string;
	projectFile: string;
}

function readLayer(file: string): Record<string, unknown> {
	if (!existsSync(file)) return {};
	const data = readConfigFile(file);
	if (!isPlainObject(data)) {
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: `Config file ${file} must contain a JSON object`,
			hint: "Fix the file so its top level is an object",
			context: { file },
		});
	}
	return data;
}

/** Reads the user and project config files (CONFIG_INVALID when one is not a JSON object). */
export function readConfigLayers(userFile: string, cwd: string): ConfigLayers {
	const projectFile = projectConfigPath(cwd);
	return { user: readLayer(userFile), project: readLayer(projectFile), userFile, projectFile };
}

/** Defaults, user and project merged without validation. */
export function mergedLayers(layers: ConfigLayers): Record<string, unknown> {
	return deepMerge(DEFAULT_CONFIG, layers.user, layers.project);
}

export function settingView(def: SettingDefinition, layers: ConfigLayers): SettingView {
	const overriddenByProject = definedIn(layers.project, def);
	const source: SettingSource = overriddenByProject
		? "project"
		: definedIn(layers.user, def)
			? "user"
			: definedIn(DEFAULT_CONFIG, def)
				? "default"
				: "unset";
	return {
		...def,
		value: displayValue(def, mergedLayers(layers)),
		source,
		userValue: definedIn(layers.user, def) ? displayValue(def, layers.user) : null,
		overriddenByProject,
		notice: overriddenByProject ? PROJECT_OVERRIDE_NOTICE : null,
	};
}

function parseModel(key: string, value: unknown): { provider: string; id: string } {
	if (typeof value === "string") {
		const slash = value.indexOf("/");
		if (slash > 0 && slash < value.length - 1) return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
	} else if (isPlainObject(value) && typeof value.provider === "string" && typeof value.id === "string" && value.provider && value.id) {
		return { provider: value.provider, id: value.id };
	}
	throw invalidRequest(`Invalid value for ${key}: expected "provider/model-id"`, 'Pick a model from the list or type "provider/model-id"', { key });
}

/** Converts text typed on the command line into the value type of a setting. */
export function parseSettingInput(def: SettingDefinition, raw: string): unknown {
	const text = raw.trim();
	if (def.type.kind !== "number") return text;
	const value = text === "" ? Number.NaN : Number(text);
	if (!Number.isFinite(value)) {
		throw invalidRequest(`Invalid value for ${def.key}: "${text}" is not a number`, undefined, { key: def.key, errors: [{ path: `/${segments(def.key).join("/")}`, message: "must be a number" }] });
	}
	return value;
}

function writeJsonAtomic(file: string, data: unknown): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
		renameSync(tmp, file);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw new NexoError({
			code: "STORE_IO",
			message: `Cannot write config file ${file}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
			hint: `Check that ${dirname(file)} is writable by you`,
			context: { file },
		});
	}
}

/**
 * Sets one key in the user config. The result is validated against the config schema together with the defaults and
 * the project config; schema errors at or below the key's path reject the change (INVALID_REQUEST naming each path)
 * and the file is left untouched. Errors elsewhere, such as a model not chosen yet on a first run, do not block it.
 * Every other key of the user config is kept.
 */
export function writeSetting(userFile: string, cwd: string, key: string, value: unknown): SettingView {
	const def = findSetting(key);
	const layers = readConfigLayers(userFile, cwd);
	const user = structuredClone(layers.user);
	const path = segments(key);
	const pointer = `/${path.join("/")}`;
	if (def.type.kind === "model") {
		const model = parseModel(key, value);
		const existing = getPath(user, path);
		setPath(user, path, { ...(isPlainObject(existing) ? existing : {}), ...model });
	} else {
		if (def.type.kind === "enum" && !(typeof value === "string" && def.type.values.includes(value))) {
			const message = `must be one of ${def.type.values.join(", ")}`;
			throw invalidRequest(`Invalid value for ${key}: ${pointer} ${message}`, undefined, { key, errors: [{ path: pointer, message }] });
		}
		setPath(user, path, value);
	}
	const errors = configErrors(deepMerge(DEFAULT_CONFIG, user, layers.project)).filter(
		(e) => e.path === pointer || e.path.startsWith(`${pointer}/`),
	);
	if (errors.length > 0) {
		throw invalidRequest(`Invalid value for ${key}: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`, undefined, { key, errors });
	}
	writeJsonAtomic(userFile, user);
	return settingView(def, { ...layers, user });
}

/** Removes one key from the user config so the project value or the default applies again. */
export function resetSetting(userFile: string, cwd: string, key: string): SettingView {
	const def = findSetting(key);
	const layers = readConfigLayers(userFile, cwd);
	if (!definedIn(layers.user, def)) return settingView(def, layers);
	const user = structuredClone(layers.user);
	for (const p of leafPaths(def)) deletePath(user, p);
	writeJsonAtomic(userFile, user);
	return settingView(def, { ...layers, user });
}
