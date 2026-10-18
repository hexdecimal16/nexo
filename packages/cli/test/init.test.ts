import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIO, runCli } from "../src/main.ts";

function io(): CliIO & { out: () => string; err: () => string } {
	let out = "";
	let err = "";
	return {
		stdout: { write: (s: string) => ((out += s), true) },
		stderr: { write: (s: string) => ((err += s), true) },
		out: () => out,
		err: () => err,
	};
}

const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(config?: unknown): { env: NodeJS.ProcessEnv; cwd: string; configFile: string } {
	const root = mkdtempSync(join(tmpdir(), "nexo-init-"));
	roots.push(root);
	mkdirSync(join(root, "home"), { recursive: true });
	const configFile = join(root, "home", "config.json");
	if (config) writeFileSync(configFile, JSON.stringify(config));
	return { env: { NEXO_HOME: join(root, "home") }, cwd: root, configFile };
}

function fauxModels(responses: ReturnType<typeof fauxAssistantMessage>[]) {
	const faux = fauxProvider({ models: [{ id: "fast", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

const noTerminal = { stdin: { isTTY: false } as never, stdout: { isTTY: false }, stderr: { isTTY: false } };

describe("nexo init", () => {
	it("--yes writes the models from flags and makes the test call", async () => {
		const h = home();
		const t = io();
		const code = await runCli(["init", "--yes", "--s1", "faux/fast", "--s2", "faux/fast"], t, { ...h, models: fauxModels([fauxAssistantMessage("ready")]) });
		expect(t.err()).toContain("s1 answered");
		expect(code).toBe(0);
		const saved = JSON.parse(readFileSync(h.configFile, "utf8"));
		expect(saved.models.s1.id).toBe("fast");
		expect(saved.models.s2.provider).toBe("faux");
	});

	it("--skip-test sets the models and makes no model call", async () => {
		const h = home();
		const t = io();
		const code = await runCli(["init", "--yes", "--skip-test", "--s1", "faux/fast", "--s2", "faux/fast"], t, { ...h, models: fauxModels([]) });
		expect(code).toBe(0);
		expect(t.err()).toContain("Skipped the test call");
		expect(existsSync(h.configFile)).toBe(true);
	});

	it("--yes without the model flags fails and names the missing flag", async () => {
		const h = home();
		const t = io();
		const code = await runCli(["init", "--yes"], t, { ...h, models: fauxModels([]) });
		expect(code).not.toBe(0);
		expect(t.err()).toContain("--s1");
	});

	it("reports a finished setup and changes nothing", async () => {
		const h = home({ models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "fast" } } });
		const before = readFileSync(h.configFile, "utf8");
		const t = io();
		const code = await runCli(["init"], t, { ...h, models: fauxModels([]), stdio: noTerminal });
		expect(code).toBe(0);
		expect(t.err()).toContain("Setup is complete");
		expect(readFileSync(h.configFile, "utf8")).toBe(before);
	});

	it("refuses to prompt without a terminal", async () => {
		const h = home();
		const t = io();
		const code = await runCli(["init"], t, { ...h, models: fauxModels([]), stdio: noTerminal });
		expect(code).not.toBe(0);
		expect(t.err()).toContain("interactive terminal");
	});
});
