import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureNexoDirs, type NexoPaths, openDb, resolveNexoPaths } from "@nexo/store";
import { createLogger, type NexoError, REDACTED } from "@nexo/telemetry";
import { nonInteractivePrompter } from "@nexo/tools";
import { loadSkills } from "@nexo/skills";
import { createEngine, createSettings, type DeepPartial, keyStatusLabel, type NexoConfig, type SettingsOptions } from "../src/index.ts";
import { FAUX_MODELS } from "./helpers.ts";

const FAUX_ROLES: DeepPartial<NexoConfig> = { models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } } };
const FILE_KEY = "file-key-0123456789abcd";

/** Provider env vars of the machine running the tests must not leak into key status (pi-ai also reads process.env). */
beforeEach(() => {
	for (const name of ["OPENAI_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "MISTRAL_API_KEY"]) vi.stubEnv(name, "");
	return () => vi.unstubAllEnvs();
});

interface Fixture {
	paths: NexoPaths;
	cwd: string;
	options: (extra?: Partial<SettingsOptions>) => SettingsOptions;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "nexo-settings-"));
	const paths = resolveNexoPaths({ NEXO_HOME: join(root, "home") });
	ensureNexoDirs(paths);
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "nexo-cwd-")));
	return { paths, cwd, options: (extra = {}) => ({ paths, cwd, env: {}, ...extra }) };
}

function mode(file: string): number {
	return statSync(file).mode & 0o777;
}

function expectCode(fn: () => unknown, code: string): NexoError {
	try {
		fn();
	} catch (error) {
		expect((error as NexoError).code).toBe(code);
		return error as NexoError;
	}
	throw new Error(`expected ${code}`);
}

function writeJson(file: string, value: unknown): void {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function fauxModels(provider = "faux"): { models: Models; faux: ReturnType<typeof fauxProvider> } {
	const faux = fauxProvider({ provider, models: FAUX_MODELS });
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, faux };
}

describe("credentials file", () => {
	it("creates credentials.json with mode 0600 in the documented format and keeps 0600 after every write", () => {
		const f = fixture();
		const settings = createSettings(f.options());
		expect(existsSync(f.paths.credentials)).toBe(false);
		settings.setKey("anthropic", FILE_KEY);
		expect(mode(f.paths.credentials)).toBe(0o600);
		expect(JSON.parse(readFileSync(f.paths.credentials, "utf8"))).toEqual({ anthropic: { apiKey: FILE_KEY } });

		chmodSync(f.paths.credentials, 0o400);
		settings.setKey("openai", "openai-key-0123456789");
		expect(mode(f.paths.credentials)).toBe(0o600);
		settings.removeKey("openai");
		expect(mode(f.paths.credentials)).toBe(0o600);
		expect(JSON.parse(readFileSync(f.paths.credentials, "utf8"))).toEqual({ anthropic: { apiKey: FILE_KEY } });
	});

	it("refuses a credentials file readable by group or others, naming the path and the chmod fix", () => {
		const f = fixture();
		writeJson(f.paths.credentials, { anthropic: { apiKey: FILE_KEY } });
		chmodSync(f.paths.credentials, 0o644);
		const error = expectCode(() => createSettings(f.options()), "CONFIG_INVALID");
		expect(error.message).toContain(f.paths.credentials);
		expect(error.hint).toContain(`chmod 600 ${f.paths.credentials}`);
		expect(JSON.stringify({ m: error.message, h: error.hint, c: error.context })).not.toContain(FILE_KEY);
	});

	it("reports invalid JSON without echoing the file contents", () => {
		const f = fixture();
		writeFileSync(f.paths.credentials, `{"anthropic": {"apiKey": "${FILE_KEY}"`, { mode: 0o600 });
		const error = expectCode(() => createSettings(f.options()), "CONFIG_INVALID");
		expect(error.message).toContain(f.paths.credentials);
		expect(error.message).not.toContain(FILE_KEY);
		expect(error.cause).toBeUndefined();
	});

	it("keeps unknown fields and providers it does not touch", () => {
		const f = fixture();
		writeFileSync(f.paths.credentials, JSON.stringify({ groq: { apiKey: "groq-key-0123456789", note: "x" } }), { mode: 0o600 });
		const settings = createSettings(f.options());
		settings.setKey("anthropic", FILE_KEY);
		expect(JSON.parse(readFileSync(f.paths.credentials, "utf8"))).toEqual({
			groq: { apiKey: "groq-key-0123456789", note: "x" },
			anthropic: { apiKey: FILE_KEY },
		});
	});
});

describe("provider keys", () => {
	it("reports env, credentials file (last 4) or not set, and never the key", () => {
		const f = fixture();
		const settings = createSettings(f.options({ env: { OPENAI_API_KEY: "env-openai-key-0123456789" } }));
		expect(settings.keyStatus("faux")).toEqual({ provider: "faux", state: "unset", envVar: null, last4: null, inFile: false });
		const set = settings.setKey("faux", FILE_KEY);
		expect(set).toEqual({ provider: "faux", state: "file", envVar: null, last4: "abcd", inFile: true });
		expect(keyStatusLabel(set)).toBe("set (credentials file, …abcd)");
		const env = settings.keyStatus("openai");
		expect(env).toMatchObject({ state: "env", envVar: "OPENAI_API_KEY", last4: null });
		expect(keyStatusLabel(env)).toBe("set (env)");
		expect(JSON.stringify(settings.keyProviders())).not.toContain(FILE_KEY);
		expect(settings.removeKey("faux")).toMatchObject({ state: "unset", inFile: false });
		expect(keyStatusLabel(settings.keyStatus("faux"))).toBe("not set");
	});

	it("prefers the environment variable over the credentials file", () => {
		const f = fixture();
		writeFileSync(f.paths.credentials, JSON.stringify({ openai: { apiKey: FILE_KEY } }), { mode: 0o600 });
		const settings = createSettings(f.options({ env: { OPENAI_API_KEY: "env-openai-key-0123456789" } }));
		expect(settings.keyStatus("openai")).toMatchObject({ state: "env", inFile: true });
		expect(settings.resolveApiKey("openai")).toBe("env-openai-key-0123456789");
		expect(settings.resolveApiKey("faux")).toBeUndefined();
	});

	it("rejects empty, short or whitespace keys and malformed provider names", () => {
		const settings = createSettings(fixture().options());
		expectCode(() => settings.setKey("faux", ""), "INVALID_REQUEST");
		expectCode(() => settings.setKey("faux", "short"), "INVALID_REQUEST");
		expectCode(() => settings.setKey("faux", "has space 0123456789"), "INVALID_REQUEST");
		expectCode(() => settings.setKey("../x", FILE_KEY), "INVALID_REQUEST");
		expect(settings.setKey("faux", `  ${FILE_KEY}\n`)).toMatchObject({ last4: "abcd" });
	});

	it("redacts stored keys from startup and new keys immediately, including in the logger", () => {
		const f = fixture();
		writeFileSync(f.paths.credentials, JSON.stringify({ groq: { apiKey: "groq-key-0123456789" } }), { mode: 0o600 });
		const settings = createSettings(f.options());
		const logger = createLogger({ dir: f.paths.logs, component: "test", redact: settings.redact, now: () => new Date("2026-10-11T00:00:00Z") });
		expect(settings.redact("x groq-key-0123456789")).toBe(`x ${REDACTED}`);
		settings.setKey("faux", FILE_KEY);
		expect(settings.redact({ out: `printed ${FILE_KEY}` })).toEqual({ out: `printed ${REDACTED}` });
		logger.info("tool output", { out: `printed ${FILE_KEY}` });
		settings.removeKey("faux");
		expect(settings.redact(FILE_KEY)).toBe(REDACTED);
		const log = readFileSync(join(f.paths.logs, "nexo-2026-10-11.log"), "utf8");
		expect(log).not.toContain(FILE_KEY);
		expect(log).toContain(REDACTED);
	});

	it("never copies keys into process.env", () => {
		const settings = createSettings(fixture().options());
		settings.setKey("faux", FILE_KEY);
		settings.resolveApiKey("faux");
		expect(Object.values(process.env)).not.toContain(FILE_KEY);
	});

	it("passes the resolved key to the provider request, env first, then the credentials file", async () => {
		for (const [provider, env, expected] of [
			["openai", { OPENAI_API_KEY: "env-openai-key-0123456789" }, "env-openai-key-0123456789"],
			["faux", {}, FILE_KEY],
		] as const) {
			const f = fixture();
			writeFileSync(f.paths.credentials, JSON.stringify({ [provider]: { apiKey: FILE_KEY } }), { mode: 0o600 });
			const { models, faux } = fauxModels(provider);
			let seen: string | undefined;
			faux.setResponses([
				async (_ctx, opts) => {
					seen = opts?.apiKey;
					return fauxAssistantMessage("ok");
				},
			]);
			const settings = createSettings(
				f.options({ env, models, overrides: { models: { s1: { provider, id: "fast" }, s2: { provider, id: "slow" } } } }),
			);
			const { config, hash } = settings.loadConfig();
			const engine = createEngine({
				config,
				configHash: hash,
				paths: f.paths,
				db: openDb(f.paths.db),
				models,
				logger: createLogger({ dir: f.paths.logs, component: "test", redact: settings.redact }),
				redact: settings.redact,
				prompter: nonInteractivePrompter,
				skills: loadSkills([]),
				resolveApiKey: settings.resolveApiKey,
			});
			const result = await engine.run({ instruction: "hi" });
			expect(result.status).toBe("succeeded");
			expect(seen).toBe(expected);
		}
	});

	it("lists providers of the configured models plus those in the credentials file", () => {
		const f = fixture();
		writeJson(f.paths.config, { models: { s1: { provider: "anthropic", id: "a" }, s2: { provider: "openai", id: "b" }, judge: [{ provider: "groq", id: "c" }] } });
		writeFileSync(f.paths.credentials, JSON.stringify({ mistral: { apiKey: "mistral-key-0123456789" }, anthropic: { apiKey: FILE_KEY } }), { mode: 0o600 });
		const settings = createSettings(f.options());
		expect(settings.keyProviders().map((s) => `${s.provider}:${s.state}`)).toEqual(["anthropic:file", "openai:unset", "groq:unset", "mistral:file"]);
	});

	it("lists a provider/model catalog from the model registry", () => {
		const { models } = fauxModels();
		const settings = createSettings(fixture().options({ models }));
		const catalog = settings.modelCatalog();
		expect(catalog.map((p) => p.provider)).toEqual(["faux"]);
		expect(catalog[0]?.models.map((m) => m.ref)).toEqual(["faux/fast", "faux/slow", "faux/pricey", "faux/free"]);
		expect(catalog[0]?.models[0]).toMatchObject({ id: "fast", contextWindow: expect.any(Number) });
	});
});

describe("config settings", () => {
	it("reports each editable setting with its effective value and source", () => {
		const f = fixture();
		writeJson(f.paths.config, { models: { s1: { provider: "anthropic", id: "a", effort: "low" }, s2: { provider: "openai", id: "b" } }, budgets: { perRunUsd: 1 } });
		writeJson(join(f.cwd, ".nexo", "config.json"), { budgets: { dailyUsd: 3 }, tools: { policy: { bash: "allow" } } });
		const settings = createSettings(f.options());
		const byKey = new Map(settings.settings().map((s) => [s.key, s]));
		expect(byKey.get("models.s1")).toMatchObject({ value: "anthropic/a", source: "user", overriddenByProject: false, type: { kind: "model" } });
		expect(byKey.get("models.s1.effort")).toMatchObject({ value: "low", source: "user" });
		expect(byKey.get("models.s2.effort")).toMatchObject({ value: null, source: "unset" });
		expect(byKey.get("budgets.perRunUsd")).toMatchObject({ value: 1, source: "user" });
		expect(byKey.get("budgets.perSessionUsd")).toMatchObject({ value: 5, source: "default" });
		expect(byKey.get("budgets.dailyUsd")).toMatchObject({ value: 3, source: "project", overriddenByProject: true });
		expect(byKey.get("tools.policy.bash")).toMatchObject({ value: "allow", source: "project", type: { kind: "enum", values: ["allow", "ask", "deny"] } });
		expect([...byKey.keys()]).toEqual([
			"models.s1",
			"models.s2",
			"models.s1.effort",
			"models.s2.effort",
			"budgets.perRunUsd",
			"budgets.perSessionUsd",
			"budgets.dailyUsd",
			"budgets.monthlyUsd",
			"tools.policy.read",
			"tools.policy.write",
			"tools.policy.edit",
			"tools.policy.bash",
			"tools.policy.web_fetch",
			"tools.policy.load_skill",
			"tools.policy.spawn",
			"tools.nonInteractiveAsk",
			"session.compactAt",
			"spawn.maxParallelSubagents",
		]);
		for (const s of byKey.values()) expect(s.description.length).toBeGreaterThan(0);
		expect(settings.getSetting("budgets.monthlyUsd").value).toBe(150);
		expectCode(() => settings.getSetting("budgets.nope"), "INVALID_REQUEST");
	});

	it("writes one key to the user config, keeping unknown and untouched keys, as 2-space JSON", () => {
		const f = fixture();
		const original = { models: { s1: { provider: "anthropic", id: "a", effort: "high" }, s2: { provider: "openai", id: "b" } }, budgets: { dailyUsd: 7 }, ui: { theme: "dark" }, customTopLevel: { keep: true } };
		writeJson(f.paths.config, original);
		const settings = createSettings(f.options());
		const result = settings.setSetting("budgets.perRunUsd", 2);
		expect(result).toMatchObject({ key: "budgets.perRunUsd", value: 2, source: "user", overriddenByProject: false });
		settings.setSetting("models.s1", "groq/llama");
		settings.setSettingFromString("tools.policy.bash", "allow");
		settings.setSettingFromString("spawn.maxParallelSubagents", "8");
		const text = readFileSync(f.paths.config, "utf8");
		expect(text).toBe(
			`${JSON.stringify(
				{
					models: { s1: { provider: "groq", id: "llama", effort: "high" }, s2: { provider: "openai", id: "b" } },
					budgets: { dailyUsd: 7, perRunUsd: 2 },
					ui: { theme: "dark" },
					customTopLevel: { keep: true },
					tools: { policy: { bash: "allow" } },
					spawn: { maxParallelSubagents: 8 },
				},
				null,
				2,
			)}\n`,
		);
	});

	it("rejects invalid values with the schema path and leaves the file untouched", () => {
		const f = fixture();
		writeJson(f.paths.config, { budgets: { dailyUsd: 7 } });
		const before = readFileSync(f.paths.config);
		const settings = createSettings(f.options());
		const cases: [string, unknown, string][] = [
			["budgets.perRunUsd", -1, "/budgets/perRunUsd"],
			["tools.policy.bash", "maybe", "/tools/policy/bash"],
			["session.compactAt", 1.5, "/session/compactAt"],
			["spawn.maxParallelSubagents", 1.5, "/spawn/maxParallelSubagents"],
			["models.s1.effort", "turbo", "/models/s1/effort"],
		];
		for (const [key, value, path] of cases) {
			const error = expectCode(() => settings.setSetting(key, value), "INVALID_REQUEST");
			expect(error.message).toContain(path);
			expect(error.context?.errors).toEqual([expect.objectContaining({ path })]);
		}
		expectCode(() => settings.setSetting("models.s1", "no-slash"), "INVALID_REQUEST");
		expectCode(() => settings.setSettingFromString("budgets.perRunUsd", "abc"), "INVALID_REQUEST");
		expectCode(() => settings.setSetting("redaction.patterns", ["x"]), "INVALID_REQUEST");
		expect(readFileSync(f.paths.config)).toEqual(before);
	});

	it("allows setting the models one at a time on a first run", () => {
		const f = fixture();
		const settings = createSettings(f.options());
		settings.setSetting("models.s1", "anthropic/a");
		settings.setSetting("models.s1.effort", "low");
		settings.setSetting("models.s2", { provider: "anthropic", id: "b" });
		expect(JSON.parse(readFileSync(f.paths.config, "utf8"))).toEqual({
			models: { s1: { provider: "anthropic", id: "a", effort: "low" }, s2: { provider: "anthropic", id: "b" } },
		});
		expect(settings.loadConfig().config.models.s1).toEqual({ provider: "anthropic", id: "a", effort: "low" });
	});

	it("reports when the project config overrides the written value", () => {
		const f = fixture();
		writeJson(join(f.cwd, ".nexo", "config.json"), { budgets: { perRunUsd: 0.25 } });
		const settings = createSettings(f.options());
		const result = settings.setSetting("budgets.perRunUsd", 2);
		expect(result).toMatchObject({ value: 0.25, userValue: 2, source: "project", overriddenByProject: true, notice: "overridden by project config" });
		expect(JSON.parse(readFileSync(f.paths.config, "utf8"))).toEqual({ budgets: { perRunUsd: 2 } });
	});

	it("resets a key to its default by removing it from the user config", () => {
		const f = fixture();
		writeJson(f.paths.config, { budgets: { perRunUsd: 2 }, ui: { theme: "dark" } });
		const settings = createSettings(f.options());
		expect(settings.resetSetting("budgets.perRunUsd")).toMatchObject({ value: 0.5, source: "default", userValue: null });
		expect(JSON.parse(readFileSync(f.paths.config, "utf8"))).toEqual({ ui: { theme: "dark" } });
	});

	it("refuses to rewrite a user config that is not valid JSON", () => {
		const f = fixture();
		writeFileSync(f.paths.config, "{ broken");
		const settings = createSettings(f.options());
		expectCode(() => settings.setSetting("budgets.perRunUsd", 2), "CONFIG_INVALID");
		expect(readFileSync(f.paths.config, "utf8")).toBe("{ broken");
	});
});

describe("first run", () => {
	it("says setup is needed when no models are configured, without throwing", () => {
		const f = fixture();
		const settings = createSettings(f.options());
		expect(settings.setupStatus()).toEqual({ needed: true, missingModels: ["s1", "s2"], providersWithoutKey: [], error: null });
		settings.setSetting("models.s1", "faux/fast");
		expect(settings.setupStatus()).toMatchObject({ needed: true, missingModels: ["s2"], providersWithoutKey: ["faux"] });
		settings.setSetting("models.s2", "faux/slow");
		settings.setKey("faux", FILE_KEY);
		expect(settings.setupStatus()).toEqual({ needed: false, missingModels: [], providersWithoutKey: [], error: null });
	});

	it("reports an unreadable config as an error instead of throwing", () => {
		const f = fixture();
		writeFileSync(f.paths.config, "{ broken");
		const status = createSettings(f.options()).setupStatus();
		expect(status).toMatchObject({ needed: false, error: { code: "CONFIG_INVALID" } });
	});
});

describe("reloadConfig", () => {
	it("returns a new hash after a setting changes and picks up keys written by another process", () => {
		const f = fixture();
		const settings = createSettings(f.options({ overrides: FAUX_ROLES }));
		const first = settings.reloadConfig();
		expect(first.redact).toBe(settings.redact);
		settings.setSetting("budgets.perRunUsd", 2);
		const second = settings.reloadConfig();
		expect(second.configHash).not.toBe(first.configHash);
		expect(second.config.budgets.perRunUsd).toBe(2);

		createSettings(f.options()).setKey("groq", "groq-key-from-elsewhere-01");
		expect(settings.redact("groq-key-from-elsewhere-01")).toBe("groq-key-from-elsewhere-01");
		settings.reloadConfig();
		expect(settings.redact("groq-key-from-elsewhere-01")).toBe(REDACTED);
		expect(settings.resolveApiKey("groq")).toBe("groq-key-from-elsewhere-01");
	});

	it("applies changed redaction patterns to the shared redactor", () => {
		const f = fixture();
		const settings = createSettings(f.options({ overrides: FAUX_ROLES }));
		settings.loadConfig();
		expect(settings.redact("acct-123456")).toBe("acct-123456");
		writeJson(f.paths.config, { redaction: { patterns: ["acct-[0-9]{6}"] } });
		settings.reloadConfig();
		expect(settings.redact("acct-123456")).toBe(REDACTED);
	});
});
