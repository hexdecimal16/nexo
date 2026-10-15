import type { Models } from "@earendil-works/pi-ai";
import { findEnvKeys, getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { NexoPaths } from "@nexo/store";
import {
	createMutableRedactor,
	createRedactor,
	createSecretSet,
	containsSecret,
	type ErrorPayload,
	type Logger,
	MIN_SECRET_LENGTH,
	type MutableRedactor,
	NexoError,
	type Redactor,
	type SecretSet,
	toErrorPayload,
} from "@nexo/telemetry";
import { configErrors, deepMerge, type LoadedConfig, loadConfig } from "../config/load.ts";
import type { DeepPartial, NexoConfig } from "../config/schema.ts";
import type { ApiKeyResolver } from "../engine/provider-gate.ts";
import {
	EDITABLE_SETTINGS,
	findSetting,
	mergedLayers,
	parseSettingInput,
	readConfigLayers,
	resetSetting,
	type SettingView,
	settingView,
	writeSetting,
} from "./config-edit.ts";
import { type CredentialsData, readCredentials, writeCredentials } from "./credentials.ts";

/**
 * A provider's key state. `env`: the provider's environment variable is set (it wins); `file`: `credentials.json`
 * holds the key; `unset`: neither. The key itself is never part of it.
 */
export interface KeyStatus {
	provider: string;
	state: "env" | "file" | "unset";
	/** The environment variable providing the key; null for ambient credentials (AWS, Google ADC) or when not `env`. */
	envVar: string | null;
	/** Last 4 characters of the stored key when `state` is `file`. */
	last4: string | null;
	/** `credentials.json` has an entry for the provider (so it can be removed), even when the environment wins. */
	inFile: boolean;
}

export interface CatalogModel {
	/** `provider/id`, the value `models.s1`/`models.s2` take. */
	ref: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
}

export interface CatalogProvider {
	provider: string;
	name: string;
	models: CatalogModel[];
}

export interface SetupStatus {
	/** True when `models.s1` or `models.s2` is missing or invalid: the interactive setup has to run first. */
	needed: boolean;
	missingModels: ("s1" | "s2")[];
	/** Providers of the configured s1/s2 models with no key in the environment or the credentials file. */
	providersWithoutKey: string[];
	/** Set when the config or credentials could not be read; `needed` is then false and the error should be shown. */
	error: ErrorPayload | null;
}

export interface SettingsOptions {
	paths: NexoPaths;
	/** Directory whose `.nexo/config.json` is the project config. */
	cwd: string;
	/** Environment the provider key variables are read from; defaults to `process.env`. Never written to. */
	env?: NodeJS.ProcessEnv;
	/** Model registry for the model catalog; without it the catalog is empty. */
	models?: Models;
	/** Per-invocation overrides (CLI flags) applied on top of the config files by `loadConfig`. */
	overrides?: DeepPartial<NexoConfig>;
}

/** Result shape of `SessionDeps.reloadConfig`. */
export interface ReloadedConfig {
	config: NexoConfig;
	configHash: string;
	redact: Redactor;
}

/** Provider keys and config editing, shared by the TUI settings screen, `nexo settings` and the runtime. */
export interface Settings {
	/**
	 * The process-wide redactor: config `redaction.patterns` plus every stored or resolved key as an exact match. Its
	 * implementation is replaced on `loadConfig`/`reloadConfig` and keys are added on `setKey`, so every holder (logger,
	 * engine, session) applies changes immediately. Keys stay redacted after removal.
	 */
	readonly redact: MutableRedactor;
	/** Key for a provider request: the environment variable first, then `credentials.json`. Bound; pass as `EngineDeps.resolveApiKey`. */
	readonly resolveApiKey: ApiKeyResolver;
	/** Loads and validates the effective config (CONFIG_INVALID as `loadConfig`) and rebuilds the redactor from its patterns. */
	loadConfig(): LoadedConfig;
	/** Re-reads `credentials.json` and the config; pass as `SessionDeps.reloadConfig` (`() => settings.reloadConfig()`). */
	reloadConfig(): ReloadedConfig;
	/** Sends warnings (keys too short to redact; never their values) to the logger, including ones raised before. */
	attachLogger(logger: Logger): void;
	/** INVALID_REQUEST unless the provider is in the registry, the config or the credentials file. */
	keyStatus(provider: string): KeyStatus;
	/** Throws INVALID_REQUEST unless `setKey` would accept the provider id (checked before asking for a key). */
	validateKeyProvider(provider: string): void;
	/** Providers of the configured models (s1, s2, judge, reflector, approver, embedding) in that order, then the others in the credentials file. */
	keyProviders(): KeyStatus[];
	/**
	 * Stores a key (trimmed; at least MIN_SECRET_LENGTH characters, no whitespace) and redacts it from now on. The
	 * provider must be in the model registry or the config. INVALID_REQUEST on bad input.
	 */
	setKey(provider: string, apiKey: string): KeyStatus;
	/** Deletes the provider's entry from `credentials.json` and returns the resulting status. */
	removeKey(provider: string): KeyStatus;
	/** Every editable setting with its effective value and source. CONFIG_INVALID when a config file is not valid JSON. */
	settings(): SettingView[];
	getSetting(key: string): SettingView;
	/** Writes one key to the user config after schema validation (see `writeSetting`). */
	setSetting(key: string, value: unknown): SettingView;
	/** `setSetting` with a value typed as text (numbers parsed). */
	setSettingFromString(key: string, raw: string): SettingView;
	resetSetting(key: string): SettingView;
	/** Never throws. */
	setupStatus(): SetupStatus;
	/** Chat models of every provider in the registry, by provider id. */
	modelCatalog(): CatalogProvider[];
}

/** What pi-ai's `getEnvApiKey` returns for ambient credentials (Google ADC, AWS profiles) instead of a key. */
const AMBIENT_CREDENTIALS = "<authenticated>";

function invalidRequest(message: string, hint?: string): NexoError {
	return new NexoError({ code: "INVALID_REQUEST", message, ...(hint ? { hint } : {}) });
}

function providerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value;
	return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelProviders(merged: Record<string, unknown>): string[] {
	const models = merged.models;
	if (!isPlainObject(models)) return [];
	const specs: unknown[] = [models.s1, models.s2, ...(Array.isArray(models.judge) ? models.judge : []), models.reflector, models.approver, models.embedding];
	const out: string[] = [];
	for (const spec of specs) {
		if (isPlainObject(spec) && typeof spec.provider === "string" && spec.provider && !out.includes(spec.provider)) out.push(spec.provider);
	}
	return out;
}

/** Configured provider names: providers of the configured models and keys of `providers`. */
function configuredProviders(merged: Record<string, unknown>): string[] {
	const out = modelProviders(merged);
	if (isPlainObject(merged.providers)) for (const name of Object.keys(merged.providers)) if (!out.includes(name)) out.push(name);
	return out;
}

export function keyStatusLabel(status: KeyStatus): string {
	if (status.state === "env") return "set (env)";
	if (status.state === "file") return `set (credentials file, …${status.last4 ?? ""})`;
	return "not set";
}

export function createSettings(options: SettingsOptions): Settings {
	const { paths, cwd } = options;
	const env = providerEnv(options.env ?? process.env);
	const secrets: SecretSet = createSecretSet();
	let patterns: readonly string[] = [];
	const redact = createMutableRedactor(createRedactor(patterns, { secrets }));
	let credentials: CredentialsData = {};
	let logger: Logger | null = null;
	const pendingWarnings: { msg: string; fields: Record<string, unknown> }[] = [];
	const warned = new Set<string>();

	const warnOnce = (id: string, msg: string, fields: Record<string, unknown>): void => {
		if (warned.has(id)) return;
		warned.add(id);
		if (logger) logger.warn(msg, fields);
		else pendingWarnings.push({ msg, fields });
	};

	/** Adds a key to the redactor; a key too short to be an exact-match pattern is logged (without its value) instead. */
	const registerSecret = (provider: string, source: "env" | "file", value: string): void => {
		if (secrets.add(value)) return;
		warnOnce(`${source}:${provider}`, "API key too short to redact; it is used but not redacted as an exact match", {
			provider,
			source,
			min_length: MIN_SECRET_LENGTH,
		});
	};

	const refreshCredentials = (): void => {
		credentials = readCredentials(paths.credentials);
		for (const [provider, entry] of Object.entries(credentials)) if (entry.apiKey) registerSecret(provider, "file", entry.apiKey);
	};

	const envKey = (provider: string): string | undefined => {
		const value = getEnvApiKey(provider, env)?.trim();
		return value ? value : undefined;
	};

	const resolveApiKey: ApiKeyResolver = (provider) => {
		const fromEnv = envKey(provider);
		if (fromEnv !== undefined) {
			if (fromEnv === AMBIENT_CREDENTIALS) return undefined;
			registerSecret(provider, "env", fromEnv);
			return fromEnv;
		}
		return credentials[provider]?.apiKey;
	};

	const configured = (): string[] => {
		try {
			return configuredProviders(deepMerge(mergedLayers(layers()), options.overrides));
		} catch {
			return [];
		}
	};

	/**
	 * Accepts provider ids of the model registry and configured providers (plus, unless `strict`, names already in the
	 * credentials file). The name is never echoed: it may be a key pasted into the wrong field.
	 */
	const validateProvider = (provider: string, strict: boolean): void => {
		const known =
			!containsSecret(provider) &&
			(options.models?.getProvider(provider) !== undefined || configured().includes(provider) || (!strict && provider in credentials));
		if (!known) {
			const ids = [...new Set([...(options.models?.getProviders().map((p) => p.id) ?? []), ...configured()])].sort();
			throw invalidRequest(
				"Unknown provider: not in the model registry or the nexo config",
				ids.length > 0 ? `Use a provider id such as ${ids.slice(0, 12).join(", ")}${ids.length > 12 ? ", …" : ""}` : "Configure models.s1/models.s2 first",
			);
		}
	};

	const layers = () => readConfigLayers(paths.config, cwd);

	const keyStatus = (provider: string): KeyStatus => {
		const stored = credentials[provider];
		const inFile = stored !== undefined;
		if (envKey(provider) !== undefined) return { provider, state: "env", envVar: findEnvKeys(provider, env)?.[0] ?? null, last4: null, inFile };
		if (stored?.apiKey) return { provider, state: "file", envVar: null, last4: stored.apiKey.slice(-4), inFile };
		return { provider, state: "unset", envVar: null, last4: null, inFile };
	};


	const loadEffective = (): LoadedConfig => {
		const loaded = loadConfig({ paths, cwd, overrides: options.overrides });
		patterns = loaded.config.redaction.patterns;
		redact.replace(createRedactor(patterns, { secrets }));
		return loaded;
	};

	/** Redacts env keys of the providers in use, since bash children inherit the environment and could print them. */
	const registerEnvKeys = (): void => {
		try {
			for (const provider of modelProviders(deepMerge(mergedLayers(layers()), options.overrides))) resolveApiKey(provider);
		} catch {
			// An unreadable config is reported by loadConfig or settings(); env keys are then registered when resolved.
		}
	};

	refreshCredentials();
	registerEnvKeys();

	return {
		redact,
		resolveApiKey,
		loadConfig: loadEffective,
		attachLogger(next) {
			logger = next;
			for (const w of pendingWarnings.splice(0)) next.warn(w.msg, w.fields);
		},
		reloadConfig() {
			refreshCredentials();
			const { config, hash } = loadEffective();
			registerEnvKeys();
			return { config, configHash: hash, redact };
		},
		validateKeyProvider(provider) {
			validateProvider(provider, true);
		},
		keyStatus(provider) {
			validateProvider(provider, false);
			return keyStatus(provider);
		},
		keyProviders() {
			let fromModels: string[] = [];
			try {
				fromModels = modelProviders(deepMerge(mergedLayers(layers()), options.overrides));
			} catch {
				fromModels = [];
			}
			const fromFile = Object.keys(credentials)
				.filter((p) => !fromModels.includes(p))
				.sort();
			return [...fromModels, ...fromFile].map(keyStatus);
		},
		setKey(provider, apiKey) {
			validateProvider(provider, true);
			const key = apiKey.trim();
			if (key.length < MIN_SECRET_LENGTH) throw invalidRequest(`The key for ${provider} is too short`, `Paste the full API key (at least ${MIN_SECRET_LENGTH} characters)`);
			if (/\s/.test(key)) throw invalidRequest(`The key for ${provider} contains whitespace`, "Paste the API key without spaces or line breaks");
			registerSecret(provider, "file", key);
			const next = { ...readCredentials(paths.credentials) };
			next[provider] = { ...next[provider], apiKey: key };
			writeCredentials(paths.credentials, next);
			refreshCredentials();
			return keyStatus(provider);
		},
		removeKey(provider) {
			validateProvider(provider, false);
			const next = { ...readCredentials(paths.credentials) };
			if (provider in next) {
				delete next[provider];
				writeCredentials(paths.credentials, next);
			}
			refreshCredentials();
			return keyStatus(provider);
		},
		settings() {
			const current = layers();
			return EDITABLE_SETTINGS.map((def) => settingView(def, current));
		},
		getSetting(key) {
			return settingView(findSetting(key), layers());
		},
		setSetting(key, value) {
			return writeSetting(paths.config, cwd, key, value);
		},
		setSettingFromString(key, raw) {
			return writeSetting(paths.config, cwd, key, parseSettingInput(findSetting(key), raw));
		},
		resetSetting(key) {
			return resetSetting(paths.config, cwd, key);
		},
		setupStatus() {
			try {
				const merged = deepMerge(mergedLayers(layers()), options.overrides);
				const errors = configErrors(merged);
				const missingModels = (["s1", "s2"] as const).filter((role) =>
					errors.some((e) => e.path === "/models" || e.path === `/models/${role}` || e.path.startsWith(`/models/${role}/`)),
				);
				const models = merged.models as Record<string, { provider?: unknown }> | undefined;
				const providersWithoutKey: string[] = [];
				for (const role of ["s1", "s2"] as const) {
					const provider = models?.[role]?.provider;
					if (missingModels.includes(role) || typeof provider !== "string" || providersWithoutKey.includes(provider)) continue;
					if (keyStatus(provider).state === "unset") providersWithoutKey.push(provider);
				}
				return { needed: missingModels.length > 0, missingModels, providersWithoutKey, error: null };
			} catch (error) {
				return { needed: false, missingModels: [], providersWithoutKey: [], error: toErrorPayload(error) };
			}
		},
		modelCatalog() {
			const models = options.models;
			if (!models) return [];
			return [...models.getProviders()]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((p) => ({
					provider: p.id,
					name: p.name,
					models: models.getModels(p.id).map((m) => ({
						ref: `${p.id}/${m.id}`,
						id: m.id,
						name: m.name,
						contextWindow: m.contextWindow,
						reasoning: m.reasoning,
					})),
				}));
		},
	};
}
