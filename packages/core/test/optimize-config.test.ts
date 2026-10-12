import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNexoPaths } from "@nexo/store";
import { DEFAULT_CONFIG, loadConfig } from "../src/index.ts";

const models = { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } };

function load(home: object, project?: object) {
	const root = mkdtempSync(join(tmpdir(), "nexo-optim-cfg-"));
	const paths = resolveNexoPaths({ NEXO_HOME: join(root, "home") });
	mkdirSync(paths.home, { recursive: true });
	writeFileSync(paths.config, JSON.stringify(home));
	if (project) {
		mkdirSync(join(root, ".nexo"), { recursive: true });
		writeFileSync(join(root, ".nexo", "config.json"), JSON.stringify(project));
	}
	return () => loadConfig({ paths, cwd: root }).config;
}

describe("optimize config", () => {
	it("fills the spec §9 defaults and keeps budgets.optimDefaultUsd", () => {
		const config = load({ models })();
		expect(config.optimize).toEqual({ minCases: 10, patience: 5, minJudgeKappa: 0.6 });
		expect(DEFAULT_CONFIG.optimize.minCases).toBe(10);
		expect(config.budgets.optimDefaultUsd).toBe(5);
		expect(load({ models, optimize: { patience: 8 } })().optimize).toEqual({ minCases: 10, patience: 8, minJudgeKappa: 0.6 });
	});

	it("refuses optimize.minJudgeKappa from a project config but accepts it from the home config", () => {
		expect(load({ models, optimize: { minJudgeKappa: 0.3 } })().optimize.minJudgeKappa).toBe(0.3);
		expect(load({ models }, { optimize: { patience: 7 } })().optimize.patience).toBe(7);
		const error = (() => {
			try {
				load({ models }, { optimize: { minJudgeKappa: -1 } })();
			} catch (e) {
				return e as { code: string; message: string; context: unknown };
			}
			throw new Error("expected loadConfig to throw");
		})();
		expect(error).toMatchObject({ code: "CONFIG_INVALID", context: { path: "/optimize/minJudgeKappa" } });
		expect(error.message).toMatch(/\/optimize\/minJudgeKappa must not be set in \.\/\.nexo\/config\.json/);
	});

	it("rejects unknown keys and out-of-range values at their exact path", () => {
		expect(() => load({ models, optimize: { minCases: 10, budget: 1 } })()).toThrow(/\/optimize\/budget is not a recognized setting/);
		expect(() => load({ models, optimize: { minCases: 2 } })()).toThrow(/\/optimize\/minCases/);
		expect(() => load({ models, optimize: { patience: 0 } })()).toThrow(/\/optimize\/patience/);
		expect(() => load({ models, optimize: { minJudgeKappa: 1.5 } })()).toThrow(/\/optimize\/minJudgeKappa/);
		expect(() => load({ models, optimize: { minJudgeKappa: "high" } })()).toThrow(/\/optimize\/minJudgeKappa/);
	});
});
