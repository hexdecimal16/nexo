import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseFactory, getSystemMessageText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveArtifact, listEvalCases, listOptimRuns, openDb, resolveNexoPaths } from "@nexo/store";
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

const homes: string[] = [];
afterEach(() => {
	for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SKILL = "---\nname: ci-fix\ndescription: Fix CI\n---\nRun the linter.\n";
const BETTER = "Run the linter, then run the tests.\n";

/**
 * A home with the ci-fix skill, a `contains: tested` scorer (so evidence is not judge-only), no escalation, and faux
 * models: the agent tests only with the better body, the reflection (models.s2, "slow") proposes it.
 */
function setup(): { env: NodeJS.ProcessEnv; cwd: string; models: ReturnType<typeof createModels> } {
	const root = mkdtempSync(join(tmpdir(), "nexo-cli-optimize-"));
	homes.push(root);
	const home = join(root, "home");
	mkdirSync(join(home, "skills", "ci-fix"), { recursive: true });
	writeFileSync(join(home, "skills", "ci-fix", "SKILL.md"), SKILL);
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } },
			providers: { faux: { retryBaseDelayMs: 0 } },
			router: { maxEscalations: 0 },
			scoring: { scorers: [{ kind: "contains", text: "tested" }] },
			learning: { enabled: false },
		}),
	);
	const faux = fauxProvider({
		models: [
			{ id: "fast", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
			{ id: "slow", cost: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0 } },
		],
	});
	const factory: FauxResponseFactory = async (context, _o, _s, model) => {
		if (model.id === "slow") return fauxAssistantMessage(JSON.stringify({ text: BETTER, rationale: "Runs never tested." }));
		const system = context.messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n");
		return fauxAssistantMessage(system.includes("then run the tests") ? "Linted and tested." : "Linted.");
	};
	faux.setResponses(Array.from({ length: 500 }, () => factory));
	const models = createModels();
	models.setProvider(faux.provider);
	return { env: { NEXO_HOME: home }, cwd: root, models };
}

describe("nexo eval add / list", () => {
	it("adds hand-written cases and lists them with their split", async () => {
		const h = setup();
		const t = io();
		expect(await runCli(["eval", "add", "--target", "skill:ci-fix", "--input", "Fix CI build 1", "--feedback", "Run the tests"], t, h)).toBe(0);
		expect(t.out()).toMatch(/Added eval case \w+ for skill:ci-fix \((feedback|pareto|holdout) split\)/);
		const l = io();
		expect(await runCli(["eval", "list", "--target", "skill:ci-fix"], l, h)).toBe(0);
		expect(l.out()).toContain("1 eval case for skill:ci-fix");
		expect(l.out()).toContain('manual Fix CI build 1 — "Run the tests"');
		const bad = io();
		expect(await runCli(["eval", "add", "--target", "judge_rubric", "--input", "x"], bad, h)).toBe(1);
		expect(bad.err()).toContain("judge_rubric cases come from reviewed runs");
	});
});

describe("nexo optimize", () => {
	it("fails with EVAL_SET_TOO_SMALL and a hint", async () => {
		const h = setup();
		const t = io();
		expect(await runCli(["optimize", "--target", "skill:ci-fix"], t, h)).toBe(1);
		expect(t.err()).toContain("error [EVAL_SET_TOO_SMALL]: Optimizing skill:ci-fix needs at least 10 eval cases");
		expect(t.err()).toContain("nexo eval add --target skill:ci-fix");
	});

	it("optimizes, lists, shows with the diff, approves and rolls back", async () => {
		const h = setup();
		for (let i = 1; i <= 12; i++) await runCli(["eval", "add", "--target", "skill:ci-fix", "--input", `Fix CI build ${i}`], io(), h);
		const run = io();
		expect(await runCli(["optimize", "--target", "skill:ci-fix", "--budget-usd", "2", "--seed", "7"], run, h)).toBe(0);
		expect(run.err()).toContain("optimizing skill:ci-fix");
		expect(run.err()).toContain("✓ accepted");
		expect(run.out()).toMatch(/holdout \(1 cases\): quality 0\.000 → 1\.000/);
		expect(run.out()).toContain("evidence: includes deterministic scorers");
		const db = openDb(resolveNexoPaths(h.env).db);
		const id = listOptimRuns(db)[0]?.id as string;
		expect(run.out()).toContain(`approve with \`nexo optimize approve ${id}\``);
		const list = io();
		expect(await runCli(["optimize", "list"], list, h)).toBe(0);
		expect(list.out()).toContain(id);
		const show = io();
		expect(await runCli(["optimize", "show", id, "--diff"], show, h)).toBe(0);
		expect(show.out()).toContain("+ Run the linter, then run the tests.");
		expect(show.out()).toContain("- Run the linter.");
		expect(await runCli(["optimize", "approve", id], io(), h)).toBe(0);
		expect(getActiveArtifact(db, "skill", "ci-fix")?.content).toContain(BETTER);
		const again = io();
		expect(await runCli(["optimize", "approve", id], again, h)).toBe(1);
		expect(again.err()).toContain("is already approved");
		const back = io();
		expect(await runCli(["optimize", "rollback", id], back, h)).toBe(0);
		expect(back.out()).toMatch(/Rolled back skill ci-fix: v\d+ retired, v1 active again/);
		expect(getActiveArtifact(db, "skill", "ci-fix")?.content).toBe(SKILL);
		expect(listEvalCases(db, "skill:ci-fix")).toHaveLength(12);
		db.close();
	});

	it("rejects bad flags and unknown ids", async () => {
		const h = setup();
		const t = io();
		expect(await runCli(["optimize", "--target", "skill:ci-fix", "--budget-usd", "0"], t, h)).toBe(2);
		expect(t.err()).toContain("--budget-usd must be a positive number");
		const missing = io();
		expect(await runCli(["optimize", "show", "01NOPE"], missing, h)).toBe(1);
		expect(missing.err()).toContain("Optimization 01NOPE does not exist");
		const router = io();
		expect(await runCli(["optimize", "--target", "router_policy"], router, h)).toBe(1);
		expect(router.err()).toContain("router_policy is not an optimization target yet");
	});
});
