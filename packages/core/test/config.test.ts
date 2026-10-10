import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EFFORTS } from "@nexo/router";
import type { NexoError } from "@nexo/telemetry";
import { resolveNexoPaths } from "@nexo/store";
import { Value } from "typebox/value";
import { DEFAULT_CONFIG, EffortSchema, loadConfig } from "../src/index.ts";

const models = { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } };

function setup(home?: unknown, project?: unknown) {
	const root = mkdtempSync(join(tmpdir(), "nexo-cfg-"));
	const paths = resolveNexoPaths({ NEXO_HOME: join(root, "home") });
	const cwd = join(root, "proj");
	mkdirSync(paths.home, { recursive: true });
	mkdirSync(join(cwd, ".nexo"), { recursive: true });
	if (home !== undefined) writeFileSync(paths.config, typeof home === "string" ? home : JSON.stringify(home));
	if (project !== undefined) writeFileSync(join(cwd, ".nexo", "config.json"), JSON.stringify(project));
	return { paths, cwd };
}

function expectConfigError(fn: () => unknown): NexoError {
	try {
		fn();
	} catch (err) {
		expect((err as NexoError).code).toBe("CONFIG_INVALID");
		return err as NexoError;
	}
	throw new Error("expected CONFIG_INVALID");
}

describe("loadConfig", () => {
	it("first run without config names the missing model roles and the file to create", () => {
		const { paths, cwd } = setup();
		const err = expectConfigError(() => loadConfig({ paths, cwd }));
		expect(err.message).toContain("/models is required");
		expect(err.hint).toContain(paths.config);
		expect(err.hint).toContain("/models/s1");
		expect(err.hint).toContain("/models/s2");
	});

	it("reports a missing nested property at its own path", () => {
		const { paths, cwd } = setup({ models: { s1: models.s1 } });
		expect(expectConfigError(() => loadConfig({ paths, cwd })).message).toContain("/models/s2 is required");
	});

	it("never mutates DEFAULT_CONFIG", () => {
		const a = setup({ models });
		const b = setup({ models });
		loadConfig({ paths: a.paths, cwd: a.cwd });
		const second = loadConfig({ paths: b.paths, cwd: b.cwd }).config;
		expect(second.skills.dirs).toEqual([join(b.paths.home, "skills"), join(b.cwd, ".nexo", "skills")]);
		expect(DEFAULT_CONFIG.skills.dirs).toEqual(["$NEXO_HOME/skills", "./.nexo/skills"]);
	});

	it("EffortSchema accepts exactly the router's efforts", () => {
		for (const effort of EFFORTS) expect(Value.Check(EffortSchema, effort)).toBe(true);
		expect(Value.Check(EffortSchema, "extreme")).toBe(false);
	});

	it("applies defaults under user values", () => {
		const { paths, cwd } = setup({ models });
		const { config, sources } = loadConfig({ paths, cwd });
		expect(config.budgets).toEqual(DEFAULT_CONFIG.budgets);
		expect(config.tools.policy.bash).toBe("ask");
		expect(sources).toEqual([paths.config]);
	});

	it("layers home < project < overrides, replacing arrays", () => {
		const { paths, cwd } = setup(
			{ models, budgets: { perRunUsd: 1 }, skills: { dirs: ["/a"] } },
			{ budgets: { perRunUsd: 2 }, skills: { dirs: ["/b"] } },
		);
		const { config } = loadConfig({ paths, cwd, overrides: { budgets: { perRunUsd: 3 } } });
		expect(config.budgets.perRunUsd).toBe(3);
		expect(config.budgets.dailyUsd).toBe(10);
		expect(config.skills.dirs).toEqual(["/b"]);
	});

	it("reports invalid JSON with the file path", () => {
		const { paths, cwd } = setup("{ nope");
		expect(expectConfigError(() => loadConfig({ paths, cwd })).message).toContain(paths.config);
	});

	it("reports unknown keys and bad values by JSON path", () => {
		const { paths, cwd } = setup({ models, budgets: { perRunUsd: -1 }, bogus: true });
		const err = expectConfigError(() => loadConfig({ paths, cwd }));
		expect(err.message).toContain("/budgets/perRunUsd");
		expect(err.message).toContain("/bogus is not a recognized setting");
	});

	it("rejects an invalid effort", () => {
		const { paths, cwd } = setup({ models: { ...models, s2: { provider: "faux", id: "slow", effort: "extreme" } } });
		expect(expectConfigError(() => loadConfig({ paths, cwd })).message).toContain("/models/s2/effort");
	});

	it("expands $NEXO_HOME, ~ and relative skill dirs", () => {
		const { paths, cwd } = setup({ models, skills: { dirs: ["$NEXO_HOME/skills", "./local"] } });
		const { config } = loadConfig({ paths, cwd });
		expect(config.skills.dirs).toEqual([join(paths.home, "skills"), join(cwd, "local")]);
	});

	it("produces a hash that ignores key order", () => {
		const a = setup({ models, budgets: { perRunUsd: 1, dailyUsd: 2 } });
		const b = setup({ budgets: { dailyUsd: 2, perRunUsd: 1 }, models });
		const ha = loadConfig({ paths: a.paths, cwd: a.cwd }).hash;
		const hb = loadConfig({ paths: b.paths, cwd: b.cwd }).hash;
		expect(ha).toBe(hb);
	});
});
