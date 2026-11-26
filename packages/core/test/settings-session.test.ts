import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ensureNexoDirs, getRun, listSpans, openDb, readRunJson, resolveNexoPaths } from "@nexo/store";
import { loadSkills } from "@nexo/skills";
import { createLogger, REDACTED } from "@nexo/telemetry";
import { nonInteractivePrompter } from "@nexo/tools";
import { createSession, createSettings, type SessionDeps } from "../src/index.ts";
import { FAUX_MODELS } from "./helpers.ts";

const KEY = "faux-secret-key-0123456789XYZ";

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...filesUnder(full));
		else out.push(full);
	}
	return out;
}

/** A session's dependencies on a fresh home, wired to real settings the way `nexo` wires them. */
function sessionSetup() {
	const root = mkdtempSync(join(tmpdir(), "nexo-settings-session-"));
	const paths = resolveNexoPaths({ NEXO_HOME: join(root, "home") });
	ensureNexoDirs(paths);
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "nexo-cwd-")));
	const faux = fauxProvider({ models: FAUX_MODELS });
	const models = createModels();
	models.setProvider(faux.provider);
	const settings = createSettings({
		paths,
		cwd,
		env: {},
		models,
		overrides: { models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } }, providers: { faux: { retryBaseDelayMs: 0, rateLimitBaseDelayMs: 0 } }, learning: { enabled: false } },
	});
	const { config, hash } = settings.loadConfig();
	const logger = createLogger({ dir: paths.logs, component: "test", redact: settings.redact });
	const deps: SessionDeps = {
		config,
		configHash: hash,
		paths,
		db: openDb(paths.db),
		models,
		logger,
		redact: settings.redact,
		prompter: nonInteractivePrompter,
		skills: loadSkills([]),
		resolveApiKey: settings.resolveApiKey,
		reloadConfig: () => settings.reloadConfig(),
		refreshKeys: () => settings.refreshKeys(),
	};
	return { paths, cwd, faux, models, settings, logger, deps };
}

describe("settings in a session", () => {
	it("uses a key set mid-session from the next turn and never stores it, even when a tool prints it", async () => {
		const { paths, cwd, faux, settings, logger, deps } = sessionSetup();

		const keys: (string | undefined)[] = [];
		faux.setResponses([
			async (_ctx, opts) => {
				keys.push(opts?.apiKey);
				return fauxAssistantMessage("Hello.");
			},
			async (_ctx, opts) => {
				keys.push(opts?.apiKey);
				return fauxAssistantMessage([fauxToolCall("read", { path: "leak.txt" })], { stopReason: "toolUse" });
			},
			async (_ctx, opts) => {
				keys.push(opts?.apiKey);
				return fauxAssistantMessage(`The file says ${KEY}`);
			},
		]);

		const session = createSession(deps, { cwd });
		const first = await session.turn("hi");
		expect(first.status).toBe("succeeded");

		settings.setKey("faux", KEY);
		writeFileSync(join(cwd, "leak.txt"), `secret: ${KEY}\n`);
		logger.info("tool printed", { out: KEY });
		const second = await session.turn(`My key is ${KEY}; read leak.txt`);
		expect(second.status).toBe("succeeded");
		session.close();

		expect(keys).toEqual([undefined, KEY, KEY]);
		expect(Object.values(process.env)).not.toContain(KEY);

		const runJson = JSON.stringify(readRunJson(second.runDir as string));
		expect(runJson).toContain(REDACTED);
		expect(JSON.stringify(listSpans(deps.db, second.trajectoryId as string))).not.toContain(KEY);
		expect(JSON.stringify(getRun(deps.db, second.trajectoryId as string))).not.toContain(KEY);
		const transcript = readFileSync(join(paths.sessions, session.id, "transcript.jsonl"), "utf8");
		expect(transcript).toContain(REDACTED);

		const stored = filesUnder(paths.home).filter((f) => f !== paths.credentials);
		expect(stored.some((f) => f.endsWith(".log"))).toBe(true);
		expect(stored.some((f) => f.endsWith("nexo.db"))).toBe(true);
		for (const file of stored) expect(readFileSync(file).includes(KEY), file).toBe(false);
	});

	it("keeps its config when another process changes a setting, and uses a key that process stores from the next turn", async () => {
		const { paths, cwd, faux, models, deps } = sessionSetup();
		// Another nexo process on the same home: its changes reach this session only through the files it writes.
		const other = createSettings({ paths, cwd, env: {}, models });
		const keys: (string | undefined)[] = [];
		faux.setResponses([
			async (_ctx, opts) => {
				keys.push(opts?.apiKey);
				return fauxAssistantMessage("Hello.");
			},
			async (_ctx, opts) => {
				keys.push(opts?.apiKey);
				return fauxAssistantMessage("Noted.");
			},
		]);
		const session = createSession(deps, { cwd });
		expect((await session.turn("hi")).status).toBe("succeeded");
		other.setSetting("budgets.perSessionUsd", 9);
		other.setKey("faux", KEY);
		const second = await session.turn(`My key is ${KEY}`);
		expect(second.status).toBe("succeeded");
		expect(keys).toEqual([undefined, KEY]);
		expect(session.budgetUsd).toBe(5);
		expect(readFileSync(join(paths.sessions, session.id, "transcript.jsonl"), "utf8")).not.toContain(KEY);
		session.refreshConfig();
		expect(session.budgetUsd).toBe(9);
		session.close();
	});
});
