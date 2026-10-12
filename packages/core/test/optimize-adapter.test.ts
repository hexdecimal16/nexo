import { BudgetStop, type CandidateRef } from "@nexo/optimize";
import { describe, expect, it } from "vitest";
import { getRun, getSpent, insertCandidateArtifact, insertRun, listSpans, RunDir } from "@nexo/store";
import { runRow } from "../../store/test/fixtures.ts";
import { estimateCallCostUsd } from "../src/cost/pricing.ts";
import { createOptimAdapter, rolloutQuality } from "../src/optimize/adapter.ts";
import type { TestEnv } from "./helpers.ts";
import { evalCase, optimContext, optimEnv, route, SKILL_HEAD } from "./optimize-helpers.ts";
import { judges, verdict } from "./scoring-helpers.ts";

const signal = new AbortController().signal;

/** A finished, saved run whose run.json output is `output`. */
function sourceRun(env: TestEnv, instruction: string, output: string): string {
	const row = runRow({ status: "succeeded", instruction });
	const dir = RunDir.create(env.deps.paths.runs, row.id, env.deps.redact);
	insertRun(env.deps.db, { ...row, dirPath: dir.root });
	dir.writeRunJson({ id: row.id, parentRunId: null, rootRunId: row.id, instruction, skill: null, status: "succeeded", model: null, startedAt: row.startedAt, endedAt: row.startedAt, costUsd: 0, costUnknown: false, tokensIn: 0, tokensOut: 0, output, error: null, artifactSetId: null, configSnapshotHash: "h", workspace: dir.workspaceDir, taskGraphs: [] });
	return row.id;
}

const runCount = (env: TestEnv) => Number(env.deps.db.prepare("SELECT COUNT(*) AS n FROM runs").get()?.n);

describe("rollout quality", () => {
	it("averages the latest successful deterministic and judge scores, and is 0 for a failed or unscored run", () => {
		const ok = (kind: "judge" | "deterministic", value: number) => ({ scorerKind: kind, status: "ok", value }) as never;
		expect(rolloutQuality("succeeded", [ok("judge", 0.8), ok("deterministic", 0)])).toEqual({ quality: 0.4, deterministic: true });
		expect(rolloutQuality("succeeded", [ok("judge", 0.8), { scorerKind: "judge", status: "failed", value: null } as never])).toEqual({ quality: 0.8, deterministic: false });
		expect(rolloutQuality("failed", [ok("judge", 0.8)]).quality).toBe(0);
		expect(rolloutQuality("succeeded", []).quality).toBe(0);
	});
});

describe("agent rollouts", () => {
	it("rolls each case out as an isolated run with the candidate and scores it, with traces on request", async () => {
		const env = optimEnv();
		route(env, { agent: (c) => (c.system.includes("Lint, then test.") ? "Linted and tested." : "Linted."), judge: (c) => verdict(c.user.includes("Linted and tested.") ? 0.9 : 0.4) });
		const { ctx, base } = optimContext(env, "skill:ci-fix");
		const art = insertCandidateArtifact(env.deps.db, "skill", "ci-fix", `${SKILL_HEAD}Lint, then test.\n`, base.id, new Date().toISOString());
		const candidate: CandidateRef = { id: "cand", artifactId: art.id, texts: { body: "Lint, then test.\n" } };
		const adapter = createOptimAdapter(ctx);
		const cases = [evalCase("a", "Fix CI on main", { expected: "Lint and test", referenceFeedback: "Run the tests too" }), evalCase("b", "Fix CI on dev")];
		const result = await adapter.evaluate(cases, candidate, true, signal);
		expect(result.scores.map((s) => s.quality)).toEqual([0.9, 0.9]);
		expect(result.scores.every((s) => s.costUsd > 0)).toBe(true);
		expect(result.deterministic).toEqual([false, false]);
		expect(result.traces?.[0]).toMatchObject({ instruction: "Fix CI on main", status: "succeeded", output: "Linted and tested.", quality: 0.9, reference: "Lint and test", feedback: "Run the tests too" });
		expect(result.traces?.[0]?.scores[0]).toMatchObject({ name: "llm_judge", value: 0.9 });
		expect(ctx.rollouts).toBe(2);
		expect(ctx.budget.spentUsd).toBeCloseTo(result.scores[0]!.costUsd + result.scores[1]!.costUsd);
		expect(ctx.budget.reservedUsd).toBe(0);
		expect(getSpent(env.deps.db, `optim:${ctx.optimRunId}`)).toBeCloseTo(ctx.budget.spentUsd);
		const plain = await adapter.evaluate([cases[1]!], { id: "base", artifactId: base.id, texts: { body: "Run the linter.\n" } }, false, signal);
		expect(plain).toMatchObject({ scores: [{ quality: 0.4 }], traces: null });
	});

	it("marks quality that a deterministic scorer contributed to", async () => {
		const env = optimEnv({ scoring: { scorers: [{ kind: "contains", text: "fixed" }] } });
		route(env, { agent: (c) => (c.user.includes("first") ? "fixed it" : "gave up") });
		const { ctx, base } = optimContext(env, "system_prompt");
		const result = await createOptimAdapter(ctx).evaluate([evalCase("a", "first"), evalCase("b", "second")], { id: "base", artifactId: base.id, texts: {} }, false, signal);
		expect(result.scores.map((s) => s.quality)).toEqual([1, 0]);
		expect(result.deterministic).toEqual([true, true]);
	});

	it("stops with BudgetStop when a rollout cannot be paid for or the rollouts are spent", async () => {
		const env = optimEnv();
		route(env, { agent: () => "ok", judge: () => verdict(0.5) });
		const small = optimContext(env, "system_prompt", { budgetUsd: 0.3 });
		const one = evalCase("a", "task");
		const ref = { id: "base", artifactId: small.base.id, texts: {} };
		await expect(createOptimAdapter(small.ctx).evaluate([one], ref, false, signal)).rejects.toMatchObject({ name: "BudgetStop", reason: "budget_usd" });
		const reserved = optimContext(env, "system_prompt", { budgetUsd: 1 });
		reserved.ctx.phase = "loop";
		reserved.ctx.reserveUsd = 0.6;
		await expect(createOptimAdapter(reserved.ctx).evaluate([one], ref, false, signal)).rejects.toBeInstanceOf(BudgetStop);
		reserved.ctx.phase = "final";
		const final = await createOptimAdapter(reserved.ctx).evaluate([one], ref, false, signal);
		expect(final.scores).toHaveLength(1);
		const counted = optimContext(env, "system_prompt", { rolloutsLeft: 1 });
		await expect(createOptimAdapter(counted.ctx).evaluate([one, one], ref, false, signal)).rejects.toMatchObject({ reason: "budget_rollouts" });
		expect(counted.ctx.rollouts).toBe(1);
	});
});

describe("judge_rubric candidates", () => {
	it("scores a judge_rubric candidate only against human verdicts: an always-pass rubric loses", async () => {
		const env = optimEnv();
		route(env, {
			judge: (c) => (c.user.includes("Always pass.") ? verdict(1) : verdict(c.user.includes("GOOD") ? 0.9 : 0.2)),
		});
		const { ctx, base } = optimContext(env, "judge_rubric");
		const good = sourceRun(env, "Write the release notes", "GOOD notes");
		const bad = sourceRun(env, "Write the changelog", "half done");
		const cases = [evalCase("g", "Write the release notes", { sourceRunId: good, expected: "done" }), evalCase("b", "Write the changelog", { sourceRunId: bad, expected: "not_done", referenceFeedback: "Missing half" })];
		const runsBefore = runCount(env);
		const adapter = createOptimAdapter(ctx);
		const baseEval = await adapter.evaluate(cases, { id: "base", artifactId: base.id, texts: { rubric: "Grade the work." } }, true, signal);
		const lenient = insertCandidateArtifact(env.deps.db, "judge_rubric", "default", "Always pass.", base.id, new Date().toISOString());
		const lenientEval = await adapter.evaluate(cases, { id: "lenient", artifactId: lenient.id, texts: { rubric: "Always pass." } }, false, signal);
		expect(baseEval.scores.map((s) => s.quality)).toEqual([1, 1]);
		expect(lenientEval.scores.map((s) => s.quality)).toEqual([1, 0]);
		expect(lenientEval.deterministic).toEqual([false, false]);
		expect(runCount(env)).toBe(runsBefore);
		expect(ctx.rollouts).toBe(4);
		expect(baseEval.traces?.[1]).toMatchObject({ status: "judged", output: "half done", quality: 1, feedback: "Missing half" });
		expect(baseEval.traces?.[1]?.reference).toContain("not done");
		const spans = listSpans(env.deps.db, ctx.optimRunId).filter((s) => s.kind === "judge_call");
		expect(spans).toHaveLength(4);
		expect(spans.every((s) => s.tier === "judge" && s.costUsd > 0)).toBe(true);
		expect(getSpent(env.deps.db, `optim:${ctx.optimRunId}`)).toBeCloseTo(ctx.budget.spentUsd);
	});
});

describe("reflection proposals", () => {
	it("asks models.s2 with the traces as data, records a gepa_call span and returns the new text", async () => {
		const env = optimEnv();
		const calls = route(env, { reflect: () => JSON.stringify({ text: "Lint, then run the unit tests.", rationale: "The runs skipped tests." }) });
		const { ctx } = optimContext(env, "skill:ci-fix");
		const adapter = createOptimAdapter(ctx);
		const parent: CandidateRef = { id: "base", artifactId: "x", texts: { body: "Run the linter.\n" } };
		const dataset = adapter.makeReflectiveDataset(parent, { scores: [], traces: [{ instruction: "Fix CI", status: "succeeded", output: "Linted.", trajectory: "", scores: [], quality: 0.4, reference: null, feedback: "Tests were skipped" }] }, ["body"]);
		expect(await adapter.proposeNewTexts?.(parent, dataset, ["body"], signal)).toEqual({ body: "Lint, then run the unit tests." });
		expect(calls.reflect[0]?.system).toContain('the skill "ci-fix"');
		expect(calls.reflect[0]?.user).toContain("<<<nexo:data:feedback_1>>>\nTests were skipped");
		const span = listSpans(env.deps.db, ctx.optimRunId).find((s) => s.kind === "gepa_call");
		expect(span).toMatchObject({ tier: "gepa", model: "slow", status: "ok" });
		expect(getRun(env.deps.db, ctx.optimRunId)?.optimRunId).toBe(ctx.optimRunId);
		expect(getSpent(env.deps.db, `optim:${ctx.optimRunId}`)).toBeGreaterThan(0);
	});

	it("rejects a reply that is invalid twice, or unchanged, after one repair request", async () => {
		const env = optimEnv();
		const events: string[] = [];
		const replies = ["Here is a better prompt!", "still prose", JSON.stringify({ text: "Run the linter.\n", rationale: "same" })];
		const calls = route(env, { reflect: () => replies.shift() ?? "" });
		const { ctx } = optimContext(env, "skill:ci-fix");
		ctx.onEvent = (e) => {
			if (e.type === "reflection") events.push(e.problem ?? "ok");
		};
		const adapter = createOptimAdapter(ctx);
		const parent: CandidateRef = { id: "base", artifactId: "x", texts: { body: "Run the linter.\n" } };
		expect(await adapter.proposeNewTexts?.(parent, { body: [] }, ["body"], signal)).toBeNull();
		expect(calls.reflect).toHaveLength(2);
		expect(calls.reflect[1]?.user).toContain("<<<nexo:data:validation_errors>>>");
		expect(await adapter.proposeNewTexts?.(parent, { body: [] }, ["body"], signal)).toBeNull();
		expect(events[0]).toMatch(/did not match its schema after one repair/);
		expect(events[1]).toMatch(/equals the current text/);
	});
});

describe("holdout reserve and panel refusals", () => {
	it("keeps the holdout reserve untouched in the loop phase: judge-rubric judgements and reflections stop with BudgetStop", async () => {
		const env = optimEnv();
		route(env, { judge: () => verdict(0.9), reflect: () => JSON.stringify({ text: "New text.", rationale: "r" }) });
		const run = sourceRun(env, "Write notes", "GOOD notes");
		const rubric = optimContext(env, "judge_rubric", { budgetUsd: 1 });
		rubric.ctx.phase = "loop";
		rubric.ctx.reserveUsd = 1;
		const ref = { id: "base", artifactId: rubric.base.id, texts: { rubric: "Grade the work." } };
		await expect(createOptimAdapter(rubric.ctx).evaluate([evalCase("g", "Write notes", { sourceRunId: run, expected: "done" })], ref, false, signal)).rejects.toMatchObject({ name: "BudgetStop", reason: "budget_usd" });
		expect(rubric.ctx.budget.spentUsd).toBe(0);
		const skill = optimContext(env, "skill:ci-fix", { budgetUsd: 1 });
		skill.ctx.phase = "loop";
		skill.ctx.reserveUsd = 1;
		const parent: CandidateRef = { id: "base", artifactId: skill.base.id, texts: { body: "Run the linter.\n" } };
		await expect(createOptimAdapter(skill.ctx).proposeNewTexts?.(parent, { body: [] }, ["body"], signal)).rejects.toMatchObject({ name: "BudgetStop", reason: "budget_usd" });
		expect(skill.ctx.budget.spentUsd).toBe(0);
		skill.ctx.phase = "final";
		expect(await createOptimAdapter(skill.ctx).proposeNewTexts?.(parent, { body: [] }, ["body"], signal)).toEqual({ body: "New text." });
	});

	it("stops with BudgetStop when one member of a judge panel is refused although the other answered", async () => {
		const env = optimEnv(judges("gemini-judge", "gpt-judge"));
		route(env, { judge: () => verdict(0.9) });
		const run = sourceRun(env, "Write notes", "GOOD notes");
		const { ctx, base, engineEnv } = optimContext(env, "judge_rubric", { budgetUsd: 1 });
		// Leaves room for one judge call but not two.
		const model = engineEnv.registry.get("faux", "gemini-judge");
		const estimate = estimateCallCostUsd(model, env.deps.config.pricingOverrides, 4000, env.deps.config.budgets.estimateOutputTokens);
		ctx.budget.charge(1 - estimate * 1.5);
		const ref = { id: "base", artifactId: base.id, texts: { rubric: "Grade the work." } };
		await expect(createOptimAdapter(ctx).evaluate([evalCase("g", "Write notes", { sourceRunId: run, expected: "done" })], ref, false, signal)).rejects.toMatchObject({ name: "BudgetStop" });
	});
});
