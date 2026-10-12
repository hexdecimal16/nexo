import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OptimReport } from "@nexo/optimize";
import {
	addEvalCase,
	addSpend,
	approveOptimRun,
	dayScope,
	ensureManualArtifact,
	getActiveArtifact,
	getArtifact,
	getOptimRun,
	getRun,
	getSpent,
	insertOptimRun,
	insertRun,
	listArtifactVersions,
	listOptimCandidates,
	queryRuns,
	recordFeedback,
} from "@nexo/store";
import { runRow } from "../../store/test/fixtures.ts";
import { createEngineEnv, type OptimizeEvent, startOptimization } from "../src/index.ts";
import type { TestEnv } from "./helpers.ts";
import { optimEnv, route, SKILL } from "./optimize-helpers.ts";
import { verdict } from "./scoring-helpers.ts";

const BETTER = "Run the linter, then run the tests.\n";

/** 12 hand-written ci-fix cases: 5 feedback, 6 pareto and 1 holdout case by their split hash. */
function addCases(env: TestEnv, count = 12): void {
	for (let i = 1; i <= count; i++) addEvalCase(env.deps.db, { target: "skill:ci-fix", input: `Fix CI build ${i}` }, env.deps.redact, new Date().toISOString());
}

/** The agent tests only with the better skill body; the judge rewards tested work; the reflection proposes BETTER. */
function script(env: TestEnv, reflect: () => string = () => JSON.stringify({ text: BETTER, rationale: "The runs never ran the tests." })) {
	return route(env, {
		agent: (c) => (c.system.includes("then run the tests") ? "Linted and tested." : "Linted."),
		judge: (c) => verdict(c.user.includes("Linted and tested.") ? 0.9 : 0.3),
		reflect,
	});
}

const NO_ESCALATION = { router: { maxEscalations: 0 } };

describe("startOptimization", () => {
	it("optimizes a skill end to end and reports on the holdout split, leaving the winner a candidate", async () => {
		const env = optimEnv(NO_ESCALATION);
		addCases(env);
		script(env);
		const events: OptimizeEvent[] = [];
		const engineEnv = createEngineEnv(env.deps);
		const { run, report } = await startOptimization(engineEnv, { target: "skill:ci-fix", budgetUsd: 2, seed: 7, onEvent: (e) => events.push(e) });
		expect(run).toMatchObject({ status: "succeeded", stopReason: "patience", reportRef: "report.json", judgeOnly: true, judgeKey: "faux/gemini-judge", holdoutBefore: 0.3, holdoutAfter: 0.9 });
		expect(events[0]).toMatchObject({ type: "start", cases: { feedback: 5, pareto: 6, holdout: 1 } });
		expect(getArtifact(env.deps.db, run.baseArtifactId)?.content).toBe(SKILL);
		const best = getArtifact(env.deps.db, run.bestArtifactId as string);
		expect(best).toMatchObject({ status: "candidate", origin: "gepa", content: `---\nname: ci-fix\ndescription: Fix CI\n---\n${BETTER}` });
		expect(getActiveArtifact(env.deps.db, "skill", "ci-fix")?.id).toBe(run.baseArtifactId);
		expect(listArtifactVersions(env.deps.db, "skill", "ci-fix").filter((a) => a.status === "candidate").map((a) => a.id)).toEqual([run.bestArtifactId]);
		const onDisk = JSON.parse(readFileSync(join(run.dirPath, "report.json"), "utf8")) as OptimReport;
		expect(onDisk).toEqual(report);
		expect(report?.holdout).toMatchObject({ wins: 1, losses: 0, ties: 0, before: { quality: 0.3 }, after: { quality: 0.9 } });
		expect(report?.diff).toContainEqual({ op: "add", text: "Run the linter, then run the tests." });
		expect(report?.lineage.map((l) => l.origin)).toEqual(["seed", "reflect"]);
		expect(report?.evidence).toMatchObject({ judgeOnly: true, humanScored: false, kappa: null, minJudgeKappa: 0.6 });
		const candidates = listOptimCandidates(env.deps.db, run.id);
		expect(candidates[1]).toMatchObject({ accepted: true, meanScore: 0.9, parentIds: [candidates[0]?.id] });
		expect(run.spentUsd).toBeGreaterThan(0);
		expect(run.spentUsd).toBeLessThanOrEqual(2);
		expect(getSpent(env.deps.db, `optim:${run.id}`)).toBeCloseTo(run.spentUsd);
		expect(run.rollouts).toBe(report?.rollouts);
		expect(getRun(env.deps.db, run.id)).toMatchObject({ status: "succeeded", optimRunId: run.id });
		expect(queryRuns(env.deps.db).runs).toEqual([]);
		expect(queryRuns(env.deps.db, { optimRunId: run.id, limit: 200 }).runs.length).toBe(run.rollouts + 1);
		expect(() => approveOptimRun(env.deps.db, run.id, { minJudgeKappa: 0.6, nowIso: new Date().toISOString() })).toThrow(/Promotion refused/);
	});

	it("fails with EVAL_SET_TOO_SMALL and lists the runs that most need review", async () => {
		const env = optimEnv(NO_ESCALATION);
		addCases(env, 3);
		const unreviewed = runRow({ status: "succeeded", skill: "ci-fix" });
		insertRun(env.deps.db, unreviewed);
		const error = await startOptimization(createEngineEnv(env.deps), { target: "skill:ci-fix" }).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "EVAL_SET_TOO_SMALL", context: { cases: 3, minCases: 10, runsToReview: [unreviewed.id] } });
		expect((error as Error).message).toMatch(/needs at least 10 eval cases.*it has 3/);
		const none = optimEnv({ ...NO_ESCALATION, optimize: { minCases: 3 } });
		addEvalCase(none.deps.db, { target: "system_prompt", input: "Fix CI build 1" }, none.deps.redact, new Date().toISOString());
		addEvalCase(none.deps.db, { target: "system_prompt", input: "Fix CI build 2" }, none.deps.redact, new Date().toISOString());
		addEvalCase(none.deps.db, { target: "system_prompt", input: "Fix CI build 3" }, none.deps.redact, new Date().toISOString());
		await expect(startOptimization(createEngineEnv(none.deps), { target: "system_prompt" })).rejects.toMatchObject({ code: "EVAL_SET_TOO_SMALL", message: expect.stringMatching(/split is empty/) });
	});

	it("refuses budgets above what is left today, too few rollouts and targets nothing can score", async () => {
		const env = optimEnv({ ...NO_ESCALATION, budgets: { dailyUsd: 3 } });
		addCases(env);
		addSpend(env.deps.db, [dayScope(new Date())], 2.5, new Date().toISOString());
		await expect(startOptimization(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 1 })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", message: expect.stringMatching(/more than what is left of the daily budget/) });
		await expect(startOptimization(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 0.4, maxRollouts: 5 })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringMatching(/--max-rollouts must be at least 20/) });
		await expect(startOptimization(createEngineEnv(env.deps), { target: "router_policy" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		const noJudge = optimEnv({ models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } } });
		await expect(startOptimization(createEngineEnv(noJudge.deps), { target: "skill:ci-fix" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringMatching(/Nothing can score candidates/) });
		expect(env.deps.db.prepare("SELECT COUNT(*) AS n FROM optim_runs").get()?.n).toBe(0);
	});

	it("stops mid-iteration when the budget runs out, stays within --budget-usd and still reports", async () => {
		// The reflection model is priced so high that its first call cannot be reserved: the iteration has rolled the
		// parent out on its minibatch when the budget stops it.
		const env = optimEnv({ ...NO_ESCALATION, pricingOverrides: { "faux/slow": { input: 0, output: 1000 } } });
		addCases(env);
		const calls = script(env);
		const events: OptimizeEvent[] = [];
		const { run, report } = await startOptimization(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 1, seed: 1, onEvent: (e) => events.push(e) });
		expect(run).toMatchObject({ status: "succeeded", stopReason: "budget_usd", bestArtifactId: run.baseArtifactId });
		expect(events.filter((e) => e.type === "iteration")).toHaveLength(1);
		expect(run.rollouts).toBe(6 + 1 + 3);
		expect(calls.reflect).toHaveLength(0);
		expect(run.spentUsd).toBeLessThanOrEqual(1);
		expect(getSpent(env.deps.db, `optim:${run.id}`)).toBeLessThanOrEqual(1);
		expect(report).toMatchObject({ improved: false, stopReason: "budget_usd", holdout: { wins: 0, losses: 0, ties: 1 } });
		expect(existsSync(join(run.dirPath, "report.json"))).toBe(true);
		expect(getActiveArtifact(env.deps.db, "skill", "ci-fix")?.id).toBe(run.baseArtifactId);
		expect(() => approveOptimRun(env.deps.db, run.id, { minJudgeKappa: 0.6, nowIso: new Date().toISOString() })).toThrow(/found nothing better/);
	});

	it("runs one iteration with exactly the minimum --max-rollouts", async () => {
		const env = optimEnv(NO_ESCALATION);
		addCases(env);
		script(env);
		const events: OptimizeEvent[] = [];
		const { run } = await startOptimization(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 2, seed: 7, maxRollouts: 20, onEvent: (e) => events.push(e) });
		expect(events.filter((e) => e.type === "iteration").length).toBeGreaterThanOrEqual(1);
		expect(run.rollouts).toBeLessThanOrEqual(20);
	});

	it("never activates a candidate while optimizing, even when aborted", async () => {
		const env = optimEnv(NO_ESCALATION);
		addCases(env);
		script(env);
		const controller = new AbortController();
		const { run, report } = await startOptimization(createEngineEnv(env.deps), {
			target: "skill:ci-fix",
			budgetUsd: 2,
			seed: 7,
			signal: controller.signal,
			onEvent: (e) => {
				if (e.type === "minibatch") {
					expect(getActiveArtifact(env.deps.db, "skill", "ci-fix")?.origin).toBe("manual");
					controller.abort();
				}
			},
		});
		expect(run).toMatchObject({ status: "aborted", stopReason: "aborted", reportRef: null });
		expect(report).toBeNull();
		expect(listArtifactVersions(env.deps.db, "skill", "ci-fix").map((a) => a.status).sort()).toEqual(["active", "retired"]);
		expect(getActiveArtifact(env.deps.db, "skill", "ci-fix")?.origin).toBe("manual");
		expect(getRun(env.deps.db, run.id)?.status).toBe("aborted");
	});

	it("marks an optimization left running by an exited process aborted before starting", async () => {
		const env = optimEnv(NO_ESCALATION);
		addCases(env, 3);
		const base = ensureManualArtifact(env.deps.db, "skill", "ci-fix", SKILL, new Date().toISOString());
		insertOptimRun(env.deps.db, { id: "01STALE", target: "skill:ci-fix", status: "running", stopReason: null, budgetUsd: 1, budgetRollouts: null, spentUsd: 0, rollouts: 0, merge: false, seed: 1, baseArtifactId: base.id, bestArtifactId: null, dirPath: "/tmp/x", reportRef: null, judgeKey: null, judgeOnly: null, holdoutBefore: null, holdoutAfter: null, promotion: null, replacedArtifactId: null, promotedAt: null, pid: 999_999, error: null, createdAt: new Date().toISOString(), endedAt: null });
		await startOptimization(createEngineEnv(env.deps), { target: "skill:ci-fix" }).catch(() => undefined);
		expect(getOptimRun(env.deps.db, "01STALE")).toMatchObject({ status: "aborted", stopReason: "process_exited" });
	});

	it("turns reviewed runs into cases before checking the eval set", async () => {
		const env = optimEnv(NO_ESCALATION);
		const reviewed = runRow({ status: "succeeded", skill: "ci-fix", instruction: "Fix the flaky test" });
		insertRun(env.deps.db, reviewed);
		recordFeedback(env.deps.db, { runId: reviewed.id, verdict: "not_done", comment: "Still flaky", nowIso: new Date().toISOString(), redact: env.deps.redact });
		const error = await startOptimization(createEngineEnv(env.deps), { target: "skill:ci-fix" }).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "EVAL_SET_TOO_SMALL", context: { cases: 1 } });
	});
});
