import { readFileSync } from "node:fs";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createSettings } from "@nexo/core";
import { describe, expect, it } from "vitest";
import { FAUX_MODELS } from "../../core/test/helpers.ts";
import { runSettingsScreen } from "../src/index.ts";
import { FakeTerminal, KEY, until } from "./fake-terminal.ts";
import { FAUX_ROLES, makeHarness, startHarness, submit } from "./helpers.ts";

const SECRET = "sk-test-SECRET-0123456789abcdefXYZ";

async function openSettings(h: Awaited<ReturnType<typeof startHarness>>): Promise<void> {
	submit(h.terminal, "/settings");
	await until(() => expect(h.terminal.output()).toContain("Settings"));
}

describe("settings screen", () => {
	it("lists key status, every editable setting with its value and source, and project overrides", async () => {
		const h = await startHarness({
			userConfig: { ...FAUX_ROLES, budgets: { perRunUsd: 2 } },
			projectConfig: { budgets: { dailyUsd: 3 } },
		});
		await openSettings(h);
		await until(() => {
			const out = h.terminal.output();
			expect(out).toMatch(/faux key\s+not set/);
			expect(out).toMatch(/Budget per run\s+2 \(user\)/);
			expect(out).toMatch(/Budget per session\s+5 \(default\)/);
			expect(out).toMatch(/Daily budget\s+3 \(project\)[^\n]*overridden by project config/);
		});
		h.terminal.send(KEY.escape);
		await until(() => expect(h.terminal.output()).toContain("settings closed"));
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("edits a number setting through the user config and reports invalid input inline", async () => {
		const h = await startHarness({ userConfig: { ...FAUX_ROLES } });
		await openSettings(h);
		h.terminal.type("per session");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("Budget per session"));
		h.terminal.type("abc");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toMatch(/error \[INVALID_REQUEST\]/));
		for (let i = 0; i < 3; i++) h.terminal.send(KEY.backspace);
		h.terminal.type("9");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.settings.getSetting("budgets.perSessionUsd")).toMatchObject({ value: 9, source: "user" }));
		expect(JSON.parse(readFileSync(h.paths.config, "utf8")).budgets.perSessionUsd).toBe(9);
		await until(() => expect(h.terminal.output()).toMatch(/Budget per session\s+9 \(user\)/));
		h.terminal.send(KEY.escape);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("refreshes the footer budget cap when settings change the session budget", async () => {
		const h = await startHarness({ userConfig: { ...FAUX_ROLES } });
		await until(() => expect(h.terminal.output()).toContain("$0.00/$5.00"));
		await openSettings(h);
		h.terminal.type("per session");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("Budget per session"));
		h.terminal.type("9");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.settings.getSetting("budgets.perSessionUsd")).toMatchObject({ value: 9, source: "user" }));
		h.terminal.send(KEY.escape);
		await until(() => expect(h.terminal.output()).toContain("$0.00/$9.00"));
		expect(h.session().budgetUsd).toBe(9);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("edits an optimize number setting", async () => {
		const h = await startHarness({ userConfig: { ...FAUX_ROLES } });
		await openSettings(h);
		h.terminal.type("optimization patience");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("Optimization patience"));
		h.terminal.type("7");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.settings.getSetting("optimize.patience")).toMatchObject({ value: 7, source: "user" }));
		expect(JSON.parse(readFileSync(h.paths.config, "utf8")).optimize).toEqual({ patience: 7 });
		h.terminal.send(KEY.escape);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("edits an enum setting from a list", async () => {
		const h = await startHarness({ userConfig: { ...FAUX_ROLES } });
		await openSettings(h);
		h.terminal.type("policy bash");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("deny"));
		h.terminal.type("deny");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.settings.getSetting("tools.policy.bash")).toMatchObject({ value: "deny", source: "user" }));
		h.terminal.send(KEY.escape);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("edits a boolean and a models list from the settings screen, and an on/off scorer toggle", async () => {
		const h = await startHarness({ userConfig: { ...FAUX_ROLES } });
		await openSettings(h);
		h.terminal.type("learning enabled");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("reset to default"));
		h.terminal.type("off");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.settings.getSetting("learning.enabled")).toMatchObject({ value: "off", source: "user" }));
		expect(JSON.parse(readFileSync(h.paths.config, "utf8")).learning.enabled).toBe(false);

		h.terminal.type("judge models");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("joined with +"));
		h.terminal.type("nope");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toMatch(/error \[INVALID_REQUEST\]/));
		for (let i = 0; i < 4; i++) h.terminal.send(KEY.backspace);
		h.terminal.type("faux/fast+faux/slow");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.settings.getSetting("models.judge")).toMatchObject({ value: "faux/fast+faux/slow", source: "user" }));

		h.terminal.type("scoring judge");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("reset to default"));
		h.terminal.type("on");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.settings.getSetting("scoring.judge")).toMatchObject({ value: "on", source: "user" }));

		h.terminal.type("reflector");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("Model reflector"));
		h.terminal.type("s2");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.settings.getSetting("models.reflector")).toMatchObject({ value: "s2", source: "user" }));
		h.terminal.send(KEY.escape);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("sets a provider key through masked input that never reaches the screen, then removes it", async () => {
		const h = await startHarness({ userConfig: { ...FAUX_ROLES } });
		await openSettings(h);
		h.terminal.type("faux key");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("Set key"));
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("input hidden"));
		h.terminal.type(SECRET);
		await until(() => expect(h.terminal.output()).toContain("•"));
		h.terminal.send(KEY.enter);
		await until(() => expect(h.settings.keyStatus("faux").state).toBe("file"));
		await until(() => expect(h.terminal.output()).toContain("set (credentials file, …fXYZ"));
		expect(JSON.parse(readFileSync(h.paths.credentials, "utf8"))).toEqual({ faux: { apiKey: SECRET } });
		expect(h.terminal.raw()).not.toContain(SECRET);
		expect(h.terminal.raw()).not.toContain(SECRET.slice(0, 12));

		h.terminal.type("faux key");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("Remove key"));
		h.terminal.send(KEY.down);
		h.terminal.send(KEY.enter);
		await until(() => expect(h.settings.keyStatus("faux").state).toBe("unset"));
		h.terminal.send(KEY.escape);
		h.terminal.send(KEY.ctrlD);
		await h.done;
		expect(h.terminal.raw()).not.toContain(SECRET);
	});

	it("shows a rejected key's error without echoing it", async () => {
		const h = await startHarness({ userConfig: { ...FAUX_ROLES } });
		await openSettings(h);
		h.terminal.type("faux key");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("Set key"));
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("input hidden"));
		h.terminal.type("shortk");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toMatch(/error \[INVALID_REQUEST\]/));
		expect(h.terminal.raw()).not.toContain("shortk");
		h.terminal.send(KEY.escape);
		h.terminal.send(KEY.escape);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("refuses /settings while a turn is running", async () => {
		const h = await startHarness();
		const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
		h.faux.setResponses([
			async (_ctx, opts) =>
				new Promise((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("late", { stopReason: "aborted" })));
				}),
		]);
		submit(h.terminal, "long");
		await until(() => h.session().running);
		submit(h.terminal, "/settings");
		await until(() => expect(h.terminal.output()).toContain("A turn is running"));
		h.terminal.send(KEY.ctrlC);
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});
});

describe("first-run setup", () => {
	it("asks for the s1 and s2 models and the provider key before the chat starts", async () => {
		const h = makeHarness({ userConfig: {} });
		const done = h.start();
		await until(() => expect(h.terminal.output()).toContain("Choose model s1"));
		expect(() => h.session()).toThrow();
		h.terminal.type("faux/fast");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("Choose model s2"));
		h.terminal.type("faux/slow");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("API key for faux"));
		h.terminal.type(SECRET);
		h.terminal.send(KEY.enter);
		await until(() => expect(h.session().status).toBe("active"));
		expect(h.settings.setupStatus().needed).toBe(false);
		expect(h.settings.getSetting("models.s1").value).toBe("faux/fast");
		expect(h.settings.getSetting("models.s2").value).toBe("faux/slow");
		expect(h.settings.keyStatus("faux").state).toBe("file");
		expect(h.session().status).toBe("active");
		expect(h.terminal.raw()).not.toContain(SECRET);
		h.terminal.send(KEY.ctrlD);
		expect(await done).toBe(0);
	});

	it("returns 1 without opening a session when setup is cancelled", async () => {
		const h = makeHarness({ userConfig: {} });
		const done = h.start();
		await until(() => expect(h.terminal.output()).toContain("Choose model s1"));
		h.terminal.send(KEY.escape);
		expect(await done).toBe(1);
		expect(h.terminal.stopped).toBe(true);
		expect(() => h.session()).toThrow();
	});
});

describe("runSettingsScreen", () => {
	it("runs the settings screen on its own terminal and restores it on close", async () => {
		const h = makeHarness({ userConfig: { ...FAUX_ROLES } });
		const terminal = new FakeTerminal();
		const done = runSettingsScreen({ settings: h.settings, terminal });
		await until(() => expect(terminal.output()).toMatch(/Model s1\s+faux\/fast \(user\)/));
		terminal.send(KEY.escape);
		expect(await done).toEqual({ completed: true });
		expect(terminal.stopped).toBe(true);
	});

	it("runs first-run setup as a standalone screen", async () => {
		const faux = fauxProvider({ models: FAUX_MODELS });
		const models = createModels();
		models.setProvider(faux.provider);
		const h = makeHarness({ userConfig: {} });
		const settings = createSettings({ paths: h.paths, cwd: h.cwd, env: {}, models });
		const terminal = new FakeTerminal();
		const done = runSettingsScreen({ settings, terminal, mode: "setup" });
		await until(() => expect(terminal.output()).toContain("Choose model s1"));
		terminal.type("faux/fast");
		terminal.send(KEY.enter);
		await until(() => expect(terminal.output()).toContain("Choose model s2"));
		terminal.type("faux/fast");
		terminal.send(KEY.enter);
		await until(() => expect(terminal.output()).toContain("API key for faux"));
		terminal.send(KEY.escape); // skip: keyless providers are allowed
		expect(await done).toEqual({ completed: true });
		expect(settings.setupStatus().needed).toBe(false);
		expect(settings.keyStatus("faux").state).toBe("unset");
	});
});
