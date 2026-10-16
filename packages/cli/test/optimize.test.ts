import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseFactory, getSystemMessageText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveArtifact, listEvalCases, listOptimRuns, openDb, resolveNexoPaths } from "@nexo/store";
import type { OptimReport } from "@nexo/optimize";
import type { OptimRunRow } from "@nexo/store";
import { climbEventLine, optimRunLine, reportLines } from "../src/optimize.ts";
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
			providers: { faux: { retryBaseDelayMs: 0, rateLimitBaseDelayMs: 0 } },
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
		expect(l.out()).toContain('manual active    Fix CI build 1 — "Run the tests"');
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

	it("warns before starting that allowed tools run once per rollout", async () => {
		const h = setup();
		for (let i = 1; i <= 12; i++) await runCli(["eval", "add", "--target", "skill:ci-fix", "--input", `Fix CI build ${i}`], io(), h);
		const run = io();
		await runCli(["optimize", "--target", "skill:ci-fix", "--budget-usd", "2", "--seed", "7"], run, h);
		const lines = run.err().split("\n");
		const notice = lines.findIndex((l) => l.startsWith("notice: rollouts replay past instructions"));
		expect(notice).toBe(0);
		expect(lines[notice]).toMatch(/tools set to allow \([^)]*\bread\b/);
		expect(lines.findIndex((l) => l.startsWith("optimizing skill:ci-fix"))).toBeGreaterThan(notice);
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

function climbRunFixture(): OptimRunRow {
	return {
		id: "01OPTIM", target: "skill:ci-fix", status: "succeeded", stopReason: "completed", budgetUsd: 2, budgetRollouts: null, spentUsd: 0.5, rollouts: 4, merge: false, seed: 1,
		baseArtifactId: "01BASE", bestArtifactId: null, dirPath: "/nowhere", reportRef: null, judgeKey: null, judgeOnly: null, holdoutBefore: null, holdoutAfter: null,
		promotion: null, replacedArtifactId: null, promotedAt: null, pid: null, error: null, createdAt: "2026-10-16T00:00:00.000Z", endedAt: null,
		mode: "climb", caseId: "01CASE", climbOutcome: "improved",
	};
}

function climbReportFixture(): OptimReport {
	const score = { quality: 0, costUsd: 0 } as OptimReport["holdout"]["before"];
	return {
		optimRunId: "01OPTIM", target: "skill:ci-fix", baseArtifactId: "01BASE", bestArtifactId: "01BASE", improved: true,
		holdout: { cases: [], before: score, after: score, wins: 0, losses: 0, ties: 0 }, diff: [], lineage: [],
		evidence: { humanScored: false, judgeOnly: true, judgeKey: null, kappa: null } as OptimReport["evidence"],
		stopReason: "completed", spentUsd: 0.5, rollouts: 4, iterations: 3, merges: 0, mergeNote: null,
		climb: { caseId: "01CASE", guardIds: ["01G"], outcome: "improved", critique: "Run the tests\u001b[31m", comparisons: [{ label: "golden", winner: "B", votes: [] }, { label: "verify", winner: "A", votes: [] }, { label: "guard 01G", winner: "tie", votes: [] }] },
		createdAt: "2026-10-16T00:00:00.000Z",
	};
}

describe("nexo optimize climb", () => {
	it("prints the climb's outcome, case and critique in list and show", () => {
		const h = setup();
		const db = openDb(resolveNexoPaths(h.env).db);
		const run = climbRunFixture();
		expect(optimRunLine(run)).toMatch(/^\S+\s+climb skill:ci-fix/);
		const text = reportLines(db, run, climbReportFixture(), 0.6).join("\n");
		db.close();
		expect(text).toContain("climb on case 01CASE (1 guard) · improved");
		expect(text).toContain("critique: Run the tests");
		expect(text).toMatch(/golden\s+golden preferred/);
		expect(text).toMatch(/verify\s+child preferred/);
		expect(text).toMatch(/guard 01G\s+tie/);
		expect(text).not.toContain("\u001b[31m");
		expect(text).not.toContain("iterations");
	});

	it("prints one line per climb step", () => {
		expect(climbEventLine({ type: "step", step: "golden", detail: "golden wins" })).toBe("  golden: golden wins");
		expect(climbEventLine({ type: "start", optimRunId: "01O", target: "skill:ci-fix", caseId: "01C", guardIds: ["01G"], budgetUsd: 2 })).toBe("climbing skill:ci-fix (01O) on case 01C with 1 guard · $2.00");
	});

	it("rejects bad flags before spending", async () => {
		const h = setup();
		const t = io();
		expect(await runCli(["optimize", "climb"], t, h)).not.toBe(0);
		expect(await runCli(["optimize", "climb", "--target", "skill:ci-fix", "--guards=-1"], t, h)).not.toBe(0);
		expect(t.err()).toMatch(/--guards must be an integer from 0 to 10/);
	});
});
