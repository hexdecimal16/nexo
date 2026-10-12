import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { createSession, createSettings, resumeSession, type DeepPartial, type NexoConfig, type Session, type SessionDeps, type Settings } from "@nexo/core";
import { loadSkills } from "@nexo/skills";
import { type Db, ensureNexoDirs, type NexoPaths, openDb, resolveNexoPaths } from "@nexo/store";
import { createLogger } from "@nexo/telemetry";
import type { Prompter } from "@nexo/tools";
import { FAUX_MODELS } from "../../core/test/helpers.ts";
import { runInteractive, type InteractiveOptions } from "../src/index.ts";
import { FakeTerminal, until } from "./fake-terminal.ts";

export const FAUX_ROLES: DeepPartial<NexoConfig> = {
	models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } },
	providers: { faux: { retryBaseDelayMs: 0 } },
	// Background learn jobs would take the scripted faux replies meant for later turns.
	learning: { enabled: false },
};

export interface Harness {
	paths: NexoPaths;
	cwd: string;
	db: Db;
	models: Models;
	faux: ReturnType<typeof fauxProvider>;
	settings: Settings;
	terminal: FakeTerminal;
	/** The session opener passed to the TUI, for tests that wrap it. */
	openSession: (prompter: Prompter) => Session;
	/** Set once the TUI opened the session. */
	session: () => Session;
	/** runInteractive's promise. */
	done: Promise<number>;
}

export interface HarnessOptions {
	/** Written to the user config instead of passing the faux roles as overrides (first-run tests pass {}). */
	userConfig?: Record<string, unknown>;
	projectConfig?: Record<string, unknown>;
	overrides?: DeepPartial<NexoConfig>;
	interactive?: Partial<InteractiveOptions>;
	/** Resume this session id instead of creating one. */
	resume?: string;
	/** Terminal width (default 100). */
	columns?: number;
	/** Reuse the home, cwd and db of an earlier harness. */
	reuse?: Pick<Harness, "paths" | "cwd">;
}

export function makeHarness(options: HarnessOptions = {}): Omit<Harness, "done"> & { start: (extra?: Partial<InteractiveOptions>) => Promise<number> } {
	const paths = options.reuse?.paths ?? resolveNexoPaths({ NEXO_HOME: join(mkdtempSync(join(tmpdir(), "nexo-tui-")), "home") });
	ensureNexoDirs(paths);
	const cwd = options.reuse?.cwd ?? realpathSync(mkdtempSync(join(tmpdir(), "nexo-tui-cwd-")));
	if (options.userConfig) writeFileSync(paths.config, `${JSON.stringify(options.userConfig, null, 2)}\n`);
	if (options.projectConfig) {
		mkdirSync(join(cwd, ".nexo"), { recursive: true });
		writeFileSync(join(cwd, ".nexo", "config.json"), `${JSON.stringify(options.projectConfig, null, 2)}\n`);
	}
	const faux = fauxProvider({ models: FAUX_MODELS });
	const models = createModels();
	models.setProvider(faux.provider);
	const overrides = options.overrides ?? (options.userConfig ? undefined : FAUX_ROLES);
	const settings = createSettings({ paths, cwd, env: {}, models, overrides });
	const db = openDb(paths.db);
	const terminal = new FakeTerminal(options.columns ?? 100);
	let opened: Session | null = null;

	const openSession = (prompter: Prompter): Session => {
		const { config, hash } = settings.loadConfig();
		const logger = createLogger({ dir: paths.logs, component: "tui-test", redact: settings.redact });
		settings.attachLogger(logger);
		const deps: SessionDeps = {
			config,
			configHash: hash,
			paths,
			db,
			models,
			logger,
			redact: settings.redact,
			prompter,
			skills: loadSkills([]),
			resolveApiKey: settings.resolveApiKey,
			reloadConfig: () => settings.reloadConfig(),
		};
		opened = options.resume ? resumeSession(deps, options.resume) : createSession(deps, { cwd });
		return opened;
	};

	return {
		paths,
		cwd,
		db,
		models,
		faux,
		settings,
		terminal,
		openSession,
		session: () => {
			if (!opened) throw new Error("session not opened yet");
			return opened;
		},
		start: (extra = {}) => runInteractive({ openSession, settings, db, terminal, ...options.interactive, ...extra }),
	};
}

/** Starts the TUI and waits until the editor is on screen. */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
	const h = makeHarness(options);
	const done = h.start();
	await until(() => h.terminal.started && h.terminal.output().includes("nexo session"));
	return { ...h, done };
}

/** Submits one line in the editor. */
export function submit(terminal: FakeTerminal, text: string): void {
	terminal.type(text);
	terminal.send("\r");
}
