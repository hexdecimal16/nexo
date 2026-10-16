import { describe, expect, it } from "vitest";
import { addEvalCase, approveOptimRun, getActiveArtifact, getArtifact, getEvalCase, listGoldens, listOptimCandidates, resolveSourcedArtifact } from "@nexo/store";
import { createEngineEnv, startClimb } from "../src/index.ts";
import type { TestEnv } from "./helpers.ts";
import { type CallContext, optimEnv, route, SKILL } from "./optimize-helpers.ts";
import { verdict } from "./scoring-helpers.ts";

const BETTER = "Run the linter, then run the tests.\n";
const NO_ESCALATION = { router: { maxEscalations: 0 } };

/** The text of the first and second answer of a pairwise prompt. */
function answers(user: string): [string, string] {
	const first = user.split("# First answer")[1]?.split("# Second answer")[0] ?? "";
	const second = user.split("# Second answer")[1] ?? "";
	return [first, second];
}

/** A pairwise reply preferring the answer that contains the earliest of `ranking` (best first). */
function prefer(c: CallContext, ranking: string[]): string {
	const [a, b] = answers(c.user);
	const rank = (s: string) => {
		const i = ranking.findIndex((r) => s.includes(r));
		return i === -1 ? ranking.length : i;
	};
	const preferred = rank(a) < rank(b) ? "first" : rank(b) < rank(a) ? "second" : "tie";
	return JSON.stringify({ preferred, rationale: "The better answer also runs the tests." });
}

interface Script {
	ranking?: string[];
	consistent?: boolean;
	reflect?: string;
}

/**
 * Agent: "Linted and tested." with the better skill body, else "Linted.". Judge: pointwise scores reward tested work;
 * pairwise calls follow `ranking`; the consistency call answers `consistent`.
 */
function script(env: TestEnv, s: Script = {}) {
	const ranking = s.ranking ?? ["GOLDEN", "Linted and tested.", "Linted."];
	return route(env, {
		agent: (c) => (c.system.includes("then run the tests") ? "Linted and tested." : "Linted."),
		judge: (c) => {
			if (c.system.includes("comparing two answers")) return prefer(c, ranking);
			if (c.system.includes("critiques")) return JSON.stringify({ consistent: s.consistent ?? true, critique: "Run the tests after linting." });
			return verdict(c.user.includes("Linted and tested.") ? 0.9 : 0.3);
		},
		reflect: () => s.reflect ?? JSON.stringify({ text: BETTER, rationale: "Adds the tests." }),
	});
}

function goldenCase(env: TestEnv, input = "Fix CI build 1", expected = "GOLDEN: linted and tested") {
	return addEvalCase(env.deps.db, { target: "skill:ci-fix", input, expected }, env.deps.redact, new Date().toISOString());
}

describe("startClimb", () => {
	it("improves the skill when the golden wins for one consistent reason and the child beats the base without regressing guards", async () => {
		const env = optimEnv(NO_ESCALATION);
		const c = goldenCase(env);
		goldenCase(env, "Fix CI build 2", "GOLDEN 2");
		goldenCase(env, "Fix CI build 3", "GOLDEN 3");
		const calls = script(env);
		const { run, report } = await startClimb(createEngineEnv(env.deps), { target: "skill:ci-fix", caseId: c.id, budgetUsd: 3, seed: 1 });
		expect(run).toMatchObject({ mode: "climb", caseId: c.id, status: "succeeded", stopReason: "completed", climbOutcome: "improved", judgeOnly: true });
		expect(run.holdoutAfter).toBeGreaterThan(run.holdoutBefore as number);
		expect(getArtifact(env.deps.db, run.bestArtifactId as string)).toMatchObject({ status: "candidate", content: `---\nname: ci-fix\ndescription: Fix CI\n---\n${BETTER}` });
		expect(report?.climb).toMatchObject({ caseId: c.id, outcome: "improved", critique: "Run the tests after linting.", guardIds: expect.any(Array) });
		expect(report?.climb?.guardIds).toHaveLength(2);
		expect(report?.climb?.comparisons.map((p) => p.label)).toEqual(["golden", "verify", ...report!.climb!.guardIds.map((g) => `guard ${g}`)]);
		expect(calls.reflect).toHaveLength(1);
		expect(calls.reflect[0]?.user).toContain("Run the tests after linting.");
		// The approve path is the GEPA one: judge-only evidence with no κ yet is refused, as for GEPA.
		expect(() => approveOptimRun(env.deps.db, run.id, { minJudgeKappa: 0.6, nowIso: new Date().toISOString() })).toThrow(/Promotion refused/);
	});

	it("raises the golden when the current version already beats it", async () => {
		const env = optimEnv(NO_ESCALATION);
		const c = goldenCase(env, "Fix CI build 1", "a weak answer");
		script(env, { ranking: ["Linted.", "a weak answer"] });
		const { run, report } = await startClimb(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 2 });
		expect(run).toMatchObject({ status: "succeeded", climbOutcome: "golden_raised", bestArtifactId: run.baseArtifactId });
		expect(getEvalCase(env.deps.db, c.id)).toMatchObject({ expected: "Linted.", goldenSource: "climb" });
		expect(listGoldens(env.deps.db, c.id).at(-1)).toMatchObject({ source: "climb", optimRunId: run.id, sourceRunId: expect.any(String) });
		expect(report?.climb?.comparisons.map((p) => p.label)).toEqual(["golden"]);
	});

	it("stops with no_signal on a tie and when the critiques disagree, leaving the text and golden alone", async () => {
		for (const s of [{ ranking: ["nothing matches"] }, { consistent: false }] as Script[]) {
			const env = optimEnv(NO_ESCALATION);
			const c = goldenCase(env);
			const calls = script(env, s);
			const { run } = await startClimb(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 2 });
			expect(run).toMatchObject({ climbOutcome: "no_signal", bestArtifactId: run.baseArtifactId });
			expect(calls.reflect).toHaveLength(0);
			expect(getEvalCase(env.deps.db, c.id)?.goldenSource).toBe("manual");
		}
	});

	it("treats an invalid consistency reply after one repair as no signal", async () => {
		const env = optimEnv(NO_ESCALATION);
		goldenCase(env);
		route(env, {
			agent: () => "Linted.",
			judge: (c) => (c.system.includes("comparing two answers") ? prefer(c, ["GOLDEN", "Linted."]) : c.system.includes("critiques") ? "not json" : verdict(0.3)),
			reflect: () => "unused",
		});
		const { run } = await startClimb(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 2 });
		expect(run.climbOutcome).toBe("no_signal");
	});

	it("ends not_improved when the child does not beat the base, and retires the child", async () => {
		const env = optimEnv(NO_ESCALATION);
		goldenCase(env);
		script(env, { ranking: ["GOLDEN", "Linted."], reflect: JSON.stringify({ text: "Lint twice.\n", rationale: "x" }) });
		const { run } = await startClimb(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 2 });
		expect(run).toMatchObject({ climbOutcome: "not_improved", bestArtifactId: run.baseArtifactId });
		const child = listOptimCandidates(env.deps.db, run.id).find((c) => c.origin === "reflect");
		expect(getArtifact(env.deps.db, child!.artifactId)?.status).toBe("retired");
	});

	it("ends guard_regressed when the base wins a guard", async () => {
		const env = optimEnv(NO_ESCALATION);
		const c = goldenCase(env, "Fix CI build 1");
		goldenCase(env, "Deploy guard", "GOLDEN guard");
		// The child wins on the climbed case, but on the guard the base's answer is preferred.
		route(env, {
			agent: (ctx) => (ctx.system.includes("then run the tests") ? (ctx.user.includes("Deploy guard") ? "Broken deploy." : "Linted and tested.") : "Linted."),
			judge: (ctx) =>
				ctx.system.includes("comparing two answers")
					? prefer(ctx, ["GOLDEN", "Linted and tested.", "Linted.", "Broken deploy."])
					: ctx.system.includes("critiques")
						? JSON.stringify({ consistent: true, critique: "Run the tests." })
						: verdict(0.5),
			reflect: () => JSON.stringify({ text: BETTER, rationale: "x" }),
		});
		const { run } = await startClimb(createEngineEnv(env.deps), { target: "skill:ci-fix", caseId: c.id, guards: 1, budgetUsd: 3 });
		expect(run.climbOutcome).toBe("guard_regressed");
	});

	it("runs with zero guards", async () => {
		const env = optimEnv(NO_ESCALATION);
		goldenCase(env);
		script(env);
		const { run, report } = await startClimb(createEngineEnv(env.deps), { target: "skill:ci-fix", guards: 0, budgetUsd: 2 });
		expect(run.climbOutcome).toBe("improved");
		expect(report?.climb?.guardIds).toEqual([]);
	});

	it("fails on an unusable reflection and on a budget too small for the baseline", async () => {
		const env = optimEnv(NO_ESCALATION);
		goldenCase(env);
		script(env, { reflect: "not json" });
		await expect(startClimb(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 2 })).rejects.toThrow(/reflection/);
		const poor = optimEnv(NO_ESCALATION);
		goldenCase(poor);
		script(poor);
		const { run } = await startClimb(createEngineEnv(poor.deps), { target: "skill:ci-fix", budgetUsd: 0.01 });
		expect(run).toMatchObject({ status: "failed", stopReason: "budget_usd", climbOutcome: null });
	});

	it("is aborted by its signal and retires its child", async () => {
		const env = optimEnv(NO_ESCALATION);
		goldenCase(env);
		const controller = new AbortController();
		route(env, {
			agent: (c) => {
				if (c.system.includes("then run the tests")) controller.abort();
				return c.system.includes("then run the tests") ? "Linted and tested." : "Linted.";
			},
			judge: (c) => (c.system.includes("comparing two answers") ? prefer(c, ["GOLDEN", "Linted and tested.", "Linted."]) : c.system.includes("critiques") ? JSON.stringify({ consistent: true, critique: "x" }) : verdict(0.5)),
			reflect: () => JSON.stringify({ text: BETTER, rationale: "x" }),
		});
		const { run } = await startClimb(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 2, signal: controller.signal });
		expect(run.status).toBe("aborted");
		const child = listOptimCandidates(env.deps.db, run.id).find((c) => c.origin === "reflect");
		expect(getArtifact(env.deps.db, child!.artifactId)?.status).toBe("retired");
	});

	it("refuses judge_rubric, a missing judge, and an approval after the skill was edited", async () => {
		const env = optimEnv(NO_ESCALATION);
		await expect(startClimb(createEngineEnv(env.deps), { target: "judge_rubric" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		const noJudge = optimEnv({ ...NO_ESCALATION, models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } } });
		goldenCase(noJudge);
		await expect(startClimb(createEngineEnv(noJudge.deps), { target: "skill:ci-fix" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });

		goldenCase(env);
		script(env);
		const { run } = await startClimb(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 3, guards: 0 });
		expect(run.climbOutcome).toBe("improved");
		resolveSourcedArtifact(env.deps.db, "skill", "ci-fix", `${SKILL}Edited by hand.\n`, new Date().toISOString());
		expect(() => approveOptimRun(env.deps.db, run.id, { minJudgeKappa: -1, nowIso: new Date().toISOString() })).toThrow(expect.objectContaining({ code: "CONFLICT" }));
		expect(getActiveArtifact(env.deps.db, "skill", "ci-fix")?.content).toContain("Edited by hand.");
	});

	it("fails with budget_usd when the budget admits the baseline but not the first comparison", async () => {
		const env = optimEnv({ ...NO_ESCALATION, budgets: { perRunUsd: 0.5 }, pricingOverrides: { "faux/gemini-judge": { input: 20_000, output: 20_000 } } });
		goldenCase(env);
		script(env);
		const { run, report } = await startClimb(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 0.5 });
		expect(report).toBeNull();
		expect(run).toMatchObject({ status: "failed", stopReason: "budget_usd", climbOutcome: null });
	});

	it("skips a guard whose base rollout fails and still improves", async () => {
		const env = optimEnv(NO_ESCALATION);
		const c = goldenCase(env, "Fix CI build 1");
		const g = goldenCase(env, "Deploy guard", "GOLDEN guard");
		const steps: string[] = [];
		route(env, {
			agent: (ctx) => {
				if (ctx.user.includes("Deploy guard")) throw new Error("guard rollout failed");
				return ctx.system.includes("then run the tests") ? "Linted and tested." : "Linted.";
			},
			judge: (ctx) =>
				ctx.system.includes("comparing two answers")
					? prefer(ctx, ["GOLDEN", "Linted and tested.", "Linted."])
					: ctx.system.includes("critiques")
						? JSON.stringify({ consistent: true, critique: "Run the tests." })
						: verdict(0.5),
			reflect: () => JSON.stringify({ text: BETTER, rationale: "x" }),
		});
		const { run, report } = await startClimb(createEngineEnv(env.deps), {
			target: "skill:ci-fix",
			caseId: c.id,
			guards: 1,
			budgetUsd: 3,
			onEvent: (e) => {
				if (e.type === "step" && e.step === "guard") steps.push(e.detail);
			},
		});
		expect(run.climbOutcome).toBe("improved");
		expect(steps).toEqual([expect.stringContaining(`${g.id}: skipped (base rollout`)]);
		expect(report?.climb?.guardIds).toEqual([g.id]);
		expect(report?.climb?.comparisons.map((p) => p.label)).toEqual(["golden", "verify"]);
		expect(report?.holdout.cases).toHaveLength(1);
	});
});
