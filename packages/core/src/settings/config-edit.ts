import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EFFORTS } from "@nexo/router";
import { NexoError } from "@nexo/telemetry";
import { configErrors, deepMerge, projectConfigPath, readConfigFile } from "../config/load.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";

/**
 * How a setting's value is entered: a `provider/model-id` reference, a list of them joined with `+`, a model or role
 * (`s1`/`s2`), one of fixed values, an on/off switch, a number, or the virtual `scoring.judge` toggle.
 */
export type SettingType =
	| { kind: "model" }
	| { kind: "models" }
	| { kind: "modelOrRef" }
	| { kind: "boolean" }
	| { kind: "scorerToggle" }
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
	/**
	 * `overridden by project config` when `overriddenByProject` (followed by `; <project file> has an invalid value: …`
	 * when the project value fails the schema), else null.
	 */
	notice: string | null;
}

/** Values of `boolean` and `scorerToggle` settings as shown and picked. */
export const ON_OFF = ["on", "off"] as const;

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
	{
		key: "budgets.perTurnShare",
		label: "Turn share of session",
		description: "Share of the session budget one chat turn may spend (0 to 1); budgets.perRunUsd still caps CLI runs",
		type: { kind: "number", integer: false, exclusiveMin: 0, max: 1 },
	},
	{ key: "budgets.dailyUsd", label: "Daily budget", description: "Spending cap per UTC day, in USD", type: USD },
	{ key: "budgets.monthlyUsd", label: "Monthly budget", description: "Spending cap per UTC month, in USD", type: USD },
	{
		key: "budgets.optimDefaultUsd",
		label: "Optimization budget",
		description: "Default spending cap for one `nexo optimize` run, in USD (--budget-usd overrides)",
		type: USD,
	},
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
		description: "What an `ask` policy does when nobody can answer (nexo run without a TTY); with auto mode on, the approver may still allow some `ask` tools first",
		type: { kind: "enum", values: ["allow", "deny"] },
	},
	{
		key: "tools.autoApprove",
		label: "Auto mode",
		description: "An approver model allows in-scope actions that would otherwise ask (on/off); /auto overrides it per session. Also applies to `nexo run`, where it can allow `ask` tools without a human even when nonInteractiveAsk is deny",
		type: { kind: "enum", values: ["off", "on"] },
	},
	{
		key: "session.compactAt",
		label: "Compact at",
		description: "Share of the context window at which a session compacts older turns (0 to 1)",
		type: { kind: "number", integer: false, exclusiveMin: 0, max: 1 },
	},
	{
		key: "session.compactAtBudgetShare",
		label: "Compact at budget share",
		description: "Also compact when one S2 request with the history would cost more than this share of a turn's budget (0 to 1; 0 = off)",
		type: { kind: "number", integer: false, min: 0, max: 1 },
	},
	{
		key: "optimize.reflectionTier",
		label: "Optimizer edit model",
		description: "Which model tier writes candidate edits in `nexo optimize` (s1 is cheaper; edit quality barely depends on model size)",
		type: { kind: "enum", values: ["s1", "s2"] },
	},
	{
		key: "optimize.maxCaseDrop",
		label: "Optimizer max case drop",
		description: "Largest quality drop on one holdout case a promoted candidate may have (0 to 1); a larger drop or a lower holdout mean reverts to the base version",
		type: { kind: "number", integer: false, min: 0, max: 1 },
	},
	{
		key: "loop.maxToolCalls",
		label: "Max tool calls",
		description: "Most tool calls one run may make before it is stopped and told to report (0 = no cap)",
		type: { kind: "number", integer: true, min: 0 },
	},
	{
		key: "loop.repeatLimit",
		label: "Repeat limit",
		description: "Most identical consecutive tool calls (same tool and arguments) before the next one is blocked (0 = off)",
		type: { kind: "number", integer: true, min: 0 },
	},
	{
		key: "spawn.maxParallelSubagents",
		label: "Parallel subagents",
		description: "Most subagents one run may have working at the same time",
		type: { kind: "number", integer: true, min: 1 },
	},
	{
		key: "models.judge",
		label: "Judge models",
		description: "Models that judge run quality, as provider/model-id; several joined with + form a panel (a/x+b/y)",
		type: { kind: "models" },
	},
	{
		key: "scoring.judge",
		label: "LLM judge scoring",
		description: "on adds an llm_judge scorer to your user config, off removes it; on needs models.judge set first",
		type: { kind: "scorerToggle" },
	},
	{
		key: "models.reflector",
		label: "Model reflector",
		description: "Model that writes lessons after a run: s1, s2 or provider/model-id",
		type: { kind: "modelOrRef" },
	},
	{
		key: "models.approver",
		label: "Model approver",
		description: "Model that decides approvals in auto mode: s1, s2 or provider/model-id (effort defaults to low)",
		type: { kind: "modelOrRef" },
	},
	{ key: "models.embedding", label: "Model embedding", description: "Embedding model for memory, eval mining and optimization novelty checks (provider/model-id); its price goes in pricingOverrides in config.json", type: { kind: "model" } },
	{ key: "learning.enabled", label: "Learning", description: "Learn lessons from judged runs (on/off)", type: { kind: "boolean" } },
	{ key: "learning.perJobUsd", label: "Learning budget per job", description: "Spending cap for one learn job, in USD", type: USD },
	{ key: "memory.enabled", label: "Memory", description: "Retrieve stored memories into the prompt (on/off)", type: { kind: "boolean" } },
	{
		key: "memory.maxTokens",
		label: "Memory tokens",
		description: "Most tokens of retrieved memories added to a prompt",
		type: { kind: "number", integer: true, min: 0 },
	},
	{
		key: "optimize.minCases",
		label: "Optimization min cases",
		description: "Fewest eval cases an optimization needs",
		type: { kind: "number", integer: true, min: 3 },
	},
	{
		key: "optimize.patience",
		label: "Optimization patience",
		description: "Iterations without a new Pareto member before an optimization stops",
		type: { kind: "number", integer: true, min: 1 },
	},
	{
		key: "optimize.minJudgeKappa",
		label: "Promotion min judge κ",
		description: "Lowest judge–human agreement (Cohen's κ) that lets judge-only evidence promote a candidate",
		type: { kind: "number", integer: false, min: -1, max: 1 },
	},
	{
		key: "optimize.noveltySimilarity",
		label: "Optimization novelty limit",
		description: "Embedding similarity (0.5 to 1) at or above which a reflected text is skipped as a near-duplicate of a candidate",
		type: { kind: "number", integer: false, min: 0.5, max: 1 },
	},
	{
		key: "optimize.offspringAlpha",
		label: "Optimization offspring penalty",
		description: "How strongly a parent's child count lowers its chance of being picked again (0 turns it off)",
		type: { kind: "number", integer: false, min: 0, max: 10 },
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

const SCORERS_PATH = ["scoring", "scorers"] as const;
const JUDGE_PATH = ["models", "judge"] as const;

function scorersOf(layer: unknown): Record<string, unknown>[] {
	const raw = getPath(layer, SCORERS_PATH);
	return Array.isArray(raw) ? raw.filter(isPlainObject) : [];
}

function hasJudgeScorer(layer: unknown): boolean {
	return scorersOf(layer).some((s) => s.kind === "llm_judge");
}

function hasJudgeModels(layer: unknown): boolean {
	const raw = getPath(layer, JUDGE_PATH);
	return Array.isArray(raw) && raw.length > 0;
}

function definedIn(layer: unknown, def: SettingDefinition): boolean {
	if (def.type.kind === "scorerToggle") return hasJudgeScorer(layer);
	return leafPaths(def).some((p) => getPath(layer, p) !== undefined);
}

function formatModel(raw: unknown): string | null {
	return isPlainObject(raw) && typeof raw.provider === "string" && typeof raw.id === "string" ? `${raw.provider}/${raw.id}` : null;
}

function displayValue(def: SettingDefinition, layer: unknown): SettingValue {
	if (def.type.kind === "scorerToggle") return hasJudgeScorer(layer) ? "on" : "off";
	const raw = getPath(layer, segments(def.key));
	if (def.type.kind === "models") {
		if (!Array.isArray(raw)) return null;
		const parts = raw.map(formatModel);
		return parts.length > 0 && parts.every((p) => p !== null) ? parts.join("+") : null;
	}
	if (def.type.kind === "modelOrRef") {
		if (isPlainObject(raw) && typeof raw.ref === "string") return raw.ref;
		return formatModel(raw);
	}
	if (def.type.kind === "boolean") return typeof raw === "boolean" ? (raw ? "on" : "off") : null;
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

function errorsUnder(config: unknown, pointer: string): { path: string; message: string }[] {
	return configErrors(config).filter((e) => e.path === pointer || e.path.startsWith(`${pointer}/`));
}

function overrideNotice(def: SettingDefinition, layers: ConfigLayers): string {
	const errors = errorsUnder(mergedLayers(layers), `/${segments(def.key).join("/")}`);
	if (errors.length === 0) return PROJECT_OVERRIDE_NOTICE;
	return `${PROJECT_OVERRIDE_NOTICE}; ${layers.projectFile} has an invalid value: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`;
}

/** Settings whose absent value still means something: the effective value and its source are `default`. */
const IMPLICIT_DEFAULTS: Record<string, string> = { "models.reflector": "s1", "models.approver": "s1" };

export function settingView(def: SettingDefinition, layers: ConfigLayers): SettingView {
	// Project scorers replace the user's list, so any `scoring.scorers` in the project config overrides the toggle.
	const overriddenByProject = def.type.kind === "scorerToggle" ? Array.isArray(getPath(layers.project, SCORERS_PATH)) : definedIn(layers.project, def);
	const implicit = IMPLICIT_DEFAULTS[def.key];
	const source: SettingSource = overriddenByProject
		? "project"
		: definedIn(layers.user, def)
			? "user"
			: definedIn(DEFAULT_CONFIG, def) || def.type.kind === "scorerToggle" || implicit !== undefined
				? "default"
				: "unset";
	return {
		...def,
		value: displayValue(def, mergedLayers(layers)) ?? implicit ?? null,
		source,
		userValue: definedIn(layers.user, def) ? displayValue(def, layers.user) : null,
		overriddenByProject,
		notice: overriddenByProject ? overrideNotice(def, layers) : null,
	};
}

/** `s1`/`s2` as a role ref, anything else as `provider/id` (or a `{provider,id}` / `{ref}` object). */
function parseModelOrRef(key: string, value: unknown): Record<string, unknown> {
	if (value === "s1" || value === "s2") return { ref: value };
	if (isPlainObject(value) && (value.ref === "s1" || value.ref === "s2") && Object.keys(value).length === 1) return { ref: value.ref };
	try {
		return parseModel(key, value);
	} catch {
		throw invalidRequest(`Invalid value for ${key}: expected "s1", "s2" or "provider/model-id"`, 'Type s1, s2 or "provider/model-id"', { key });
	}
}

/** Carries a stored `effort` over when an existing entry has the same provider and id. */
function keepEffort<T extends Record<string, unknown>>(model: T, existing: unknown[]): T {
	const old = existing.find((e) => isPlainObject(e) && "provider" in model && e.provider === model.provider && e.id === model.id);
	return isPlainObject(old) && old.effort !== undefined ? { ...model, effort: old.effort } : model;
}

/** `provider/id` entries joined with `+` (or an array of them); at least one, none empty. */
function parseModels(key: string, value: unknown): { provider: string; id: string }[] {
	const parts = typeof value === "string" ? value.split("+").map((p) => p.trim()) : Array.isArray(value) ? value : [];
	if (parts.length === 0) {
		throw invalidRequest(`Invalid value for ${key}: expected one or more "provider/model-id" joined with +`, 'For example "google/gemini-x" or "google/a+openai/b"', { key });
	}
	try {
		return parts.map((p) => parseModel(key, p));
	} catch {
		throw invalidRequest(`Invalid value for ${key}: expected one or more "provider/model-id" joined with +`, 'For example "google/gemini-x" or "google/a+openai/b"', { key });
	}
}

/** `on`/`true` and `off`/`false` (any case) or a JSON boolean. */
function parseOnOff(key: string, value: unknown): boolean {
	if (typeof value === "boolean") return value;
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (text === "on" || text === "true") return true;
	if (text === "off" || text === "false") return false;
	const pointer = `/${segments(key).join("/")}`;
	throw invalidRequest(`Invalid value for ${key}: ${pointer} must be on or off`, "Use on, off, true or false", { key, errors: [{ path: pointer, message: "must be on or off" }] });
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

/** Plain decimal numbers only: no hex, binary, exponent, separators or Infinity. */
const DECIMAL = /^-?(\d+(\.\d+)?|\.\d+)$/;

/** Converts text typed on the command line into the value type of a setting. */
export function parseSettingInput(def: SettingDefinition, raw: string): unknown {
	const text = raw.trim();
	if (def.type.kind !== "number") return text;
	const value = DECIMAL.test(text) ? Number(text) : Number.NaN;
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

function parseJudgeToggle(key: string, value: unknown): boolean {
	if (value === "on" || value === "off") return value === "on";
	const pointer = `/${segments(key).join("/")}`;
	throw invalidRequest(`Invalid value for ${key}: ${pointer} must be one of ${ON_OFF.join(", ")}`, undefined, { key, errors: [{ path: pointer, message: `must be one of ${ON_OFF.join(", ")}` }] });
}

/**
 * `scoring.judge` edits the user config's `scoring.scorers`: on adds `{ kind: "llm_judge", name: "quality" }` unless an
 * llm_judge scorer is there, off removes every llm_judge scorer; other scorers stay. A config with an llm_judge scorer
 * and no `models.judge` fails to load, so on needs a judge model in the effective config.
 */
function writeJudgeToggle(def: SettingDefinition, layers: ConfigLayers, userFile: string, on: boolean): SettingView {
	const user = structuredClone(layers.user);
	const present = hasJudgeScorer(user);
	if (on === present) return settingView(def, layers);
	if (on) {
		if (!hasJudgeModels(user)) {
			throw invalidRequest(`Cannot turn ${def.key} on: no judge model is set in your user config`, "Set models.judge first (for example google/<model-id>); an llm_judge scorer without one makes the config invalid", { key: def.key });
		}
		setPath(user, SCORERS_PATH, [...scorersOf(user), { kind: "llm_judge", name: "quality" }]);
	} else {
		const kept = scorersOf(user).filter((s) => s.kind !== "llm_judge");
		if (kept.length > 0) setPath(user, SCORERS_PATH, kept);
		else deletePath(user, SCORERS_PATH);
	}
	const errors = errorsUnder(deepMerge(DEFAULT_CONFIG, user), "/scoring/scorers");
	if (errors.length > 0) throw invalidRequest(`Invalid value for ${def.key}: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`, undefined, { key: def.key, errors });
	writeJsonAtomic(userFile, user);
	return settingView(def, { ...layers, user });
}

/**
 * Sets one key in the user config. The candidate user config is validated against the config schema on top of the
 * defaults; schema errors at or below the key's path reject the change (INVALID_REQUEST naming each path) and the file
 * is left untouched. Errors elsewhere, such as a model not chosen yet on a first run, do not block it. The project
 * config is not part of the check: when it holds an invalid value for the key, the returned view's notice names it.
 * Every other key of the user config is kept.
 */
export function writeSetting(userFile: string, cwd: string, key: string, value: unknown): SettingView {
	const def = findSetting(key);
	const layers = readConfigLayers(userFile, cwd);
	const user = structuredClone(layers.user);
	if (def.type.kind === "scorerToggle") return writeJudgeToggle(def, layers, userFile, parseJudgeToggle(key, value));
	const path = segments(key);
	const pointer = `/${path.join("/")}`;
	if (def.type.kind === "models") {
		const existing = getPath(user, path);
		setPath(user, path, parseModels(key, value).map((m) => keepEffort(m, Array.isArray(existing) ? existing : [])));
	} else if (def.type.kind === "modelOrRef") {
		const next = parseModelOrRef(key, value);
		setPath(user, path, keepEffort(next, [getPath(user, path)]));
	} else if (def.type.kind === "boolean") {
		setPath(user, path, parseOnOff(key, value));
	} else if (def.type.kind === "model") {
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
	const errors = errorsUnder(deepMerge(DEFAULT_CONFIG, user), pointer);
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
	if (def.type.kind === "scorerToggle") return writeJudgeToggle(def, layers, userFile, false);
	if (!definedIn(layers.user, def)) return settingView(def, layers);
	const user = structuredClone(layers.user);
	for (const p of leafPaths(def)) deletePath(user, p);
	if (def.key === "models.judge" && hasJudgeScorer(user) && !hasJudgeModels(user)) {
		throw invalidRequest("Cannot reset models.judge while an llm_judge scorer is configured", "Turn scoring.judge off first (or remove the llm_judge scorer)", { key: def.key });
	}
	writeJsonAtomic(userFile, user);
	return settingView(def, { ...layers, user });
}
