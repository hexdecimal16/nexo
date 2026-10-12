import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNexoPaths } from "@nexo/store";
import { DEFAULT_CONFIG, loadConfig } from "../src/index.ts";

const models = { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } };

function load(home: object) {
	const root = mkdtempSync(join(tmpdir(), "nexo-optim-cfg-"));
	const paths = resolveNexoPaths({ NEXO_HOME: join(root, "home") });
	mkdirSync(paths.home, { recursive: true });
	writeFileSync(paths.config, JSON.stringify(home));
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

	it("rejects unknown keys and out-of-range values at their exact path", () => {
		expect(() => load({ models, optimize: { minCases: 10, budget: 1 } })()).toThrow(/\/optimize\/budget is not a recognized setting/);
		expect(() => load({ models, optimize: { minCases: 2 } })()).toThrow(/\/optimize\/minCases/);
		expect(() => load({ models, optimize: { patience: 0 } })()).toThrow(/\/optimize\/patience/);
		expect(() => load({ models, optimize: { minJudgeKappa: 1.5 } })()).toThrow(/\/optimize\/minJudgeKappa/);
		expect(() => load({ models, optimize: { minJudgeKappa: "high" } })()).toThrow(/\/optimize\/minJudgeKappa/);
	});
});
