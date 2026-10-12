import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createModels,
	type FauxModelDefinition,
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxProvider,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { loadSkills, type SkillCatalog } from "@nexo/skills";
import { ensureNexoDirs, openDb, resolveNexoPaths } from "@nexo/store";
import { createLogger, createRedactor } from "@nexo/telemetry";
import { nonInteractivePrompter, type Prompter } from "@nexo/tools";
import { type DeepPartial, loadConfig, type NexoConfig } from "../src/index.ts";
import type { EngineDeps } from "../src/engine/run.ts";

export const FAUX_MODELS: FauxModelDefinition[] = [
	{ id: "fast", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
	{ id: "slow", cost: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0 } },
	{ id: "pricey", cost: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 } },
	{ id: "free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
];

export interface TestEnv {
	deps: EngineDeps;
	faux: ReturnType<typeof fauxProvider>;
	home: string;
}

export function makeEnv(
	options: {
		config?: DeepPartial<NexoConfig>;
		skills?: Record<string, string>;
		prompter?: Prompter;
		cwd?: string;
		/** Faux models added to FAUX_MODELS (judge models in scoring tests). */
		extraModels?: FauxModelDefinition[];
	} = {},
): TestEnv {
	const root = mkdtempSync(join(tmpdir(), "nexo-engine-"));
	const paths = resolveNexoPaths({ NEXO_HOME: join(root, "home") });
	ensureNexoDirs(paths);
	for (const [name, content] of Object.entries(options.skills ?? {})) {
		mkdirSync(join(paths.skills, name), { recursive: true });
		writeFileSync(join(paths.skills, name, "SKILL.md"), content);
	}
	const faux = fauxProvider({ models: [...FAUX_MODELS, ...(options.extraModels ?? [])] });
	const models = createModels();
	models.setProvider(faux.provider);
	const { config, hash } = loadConfig({
		paths,
		cwd: options.cwd ?? root,
		overrides: {
			models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } },
			providers: { faux: { retryBaseDelayMs: 0 } },
			// Learn jobs would consume the scripted faux replies of later turns; learning tests turn it on (learn-helpers.ts).
			learning: { enabled: false },
			...options.config,
		},
	});
	const redact = createRedactor(config.redaction.patterns);
	const skills: SkillCatalog = loadSkills(config.skills.dirs);
	const deps: EngineDeps = {
		config,
		configHash: hash,
		paths,
		db: openDb(paths.db),
		models,
		logger: createLogger({ dir: paths.logs, component: "test", redact }),
		redact,
		prompter: options.prompter ?? nonInteractivePrompter,
		skills,
	};
	return { deps, faux, home: paths.home };
}

export function firstUserText(context: TranscriptContext): string {
	const msg = context.messages.find((m) => m.role === "user");
	if (!msg) return "";
	return typeof msg.content === "string" ? msg.content : msg.content.map((b) => ("text" in b ? b.text : "")).join("");
}

/**
 * The tool's own output: the first text block of the last tool result. The engine's budget line is a separate
 * text block appended by `transformContext`, so it is excluded.
 */
export function lastToolResultText(context: TranscriptContext): string {
	const msg = [...context.messages].reverse().find((m) => m.role === "toolResult");
	if (!msg || msg.role !== "toolResult") return "";
	const first = msg.content.find((b) => b.type === "text");
	return first && "text" in first ? first.text : "";
}

/** Routes each provider call to a per-run script, keyed by a marker string contained in the run's first user message. */
export function dispatcher(scripts: Record<string, FauxResponseStep[]>): FauxResponseFactory {
	const counters = new Map<string, number>();
	return async (context, opts, state, model) => {
		const text = firstUserText(context);
		const key = Object.keys(scripts).find((k) => text.includes(k));
		if (!key) throw new Error(`no script for: ${text.slice(0, 80)}`);
		const index = counters.get(key) ?? 0;
		counters.set(key, index + 1);
		const step = scripts[key]?.[index];
		if (!step) throw new Error(`script ${key} exhausted at step ${index}`);
		return typeof step === "function" ? step(context, opts, state, model) : (step as AssistantMessage);
	};
}

export function useDispatcher(env: TestEnv, scripts: Record<string, FauxResponseStep[]>, calls = 60): void {
	const factory = dispatcher(scripts);
	env.faux.setResponses(Array.from({ length: calls }, () => factory));
}
