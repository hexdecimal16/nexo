import { describe, expect, it } from "vitest";
import { createRedactor } from "@nexo/telemetry";
import {
	appendArtifactVersion,
	approveOptimRun,
	checkPromotion,
	type Db,
	ensureManualArtifact,
	getActiveArtifact,
	getArtifact,
	getOptimRun,
	insertCandidateArtifact,
	insertOptimCandidate,
	insertOptimRun,
	insertRun,
	insertScore,
	listArtifactVersions,
	listOptimCandidates,
	listOptimRuns,
	type OptimRunRow,
	openDb,
	recordFeedback,
	recoverCrashedOptimRuns,
	resolveSourcedArtifact,
	retireOptimCandidates,
	rollbackOptimRun,
	updateOptimCandidate,
	updateOptimRun,
} from "../src/index.ts";
import { runRow, scoreRow } from "./fixtures.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const redact = createRedactor();
const JUDGE = "faux/gemini-judge";

function optimRun(db: Db, overrides: Partial<OptimRunRow> = {}): OptimRunRow {
	const base = overrides.baseArtifactId ?? ensureManualArtifact(db, "skill", "ci-fix", "---\nname: ci-fix\n---\nv1", NOW).id;
	const row: OptimRunRow = {
		id: overrides.id ?? `01OPT${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
		target: "skill:ci-fix",
		status: "running",
		stopReason: null,
		budgetUsd: 5,
		budgetRollouts: null,
		spentUsd: 0,
		rollouts: 0,
		merge: false,
		seed: 1,
		baseArtifactId: base,
		bestArtifactId: null,
		dirPath: "/tmp/optim/x",
		reportRef: null,
		judgeKey: null,
		judgeOnly: null,
		holdoutBefore: null,
		holdoutAfter: null,
		promotion: null,
		replacedArtifactId: null,
		promotedAt: null,
		pid: null,
		error: null,
		createdAt: NOW,
		endedAt: null,
		...overrides,
	};
	insertOptimRun(db, row);
	return row;
}

/** A succeeded optimization of skill ci-fix whose best candidate is a new `candidate` version. */
function finished(db: Db, overrides: Partial<OptimRunRow> = {}): { run: OptimRunRow; best: string; base: string } {
	const base = ensureManualArtifact(db, "skill", "ci-fix", "---\nname: ci-fix\n---\nv1", NOW);
	const best = insertCandidateArtifact(db, "skill", "ci-fix", "---\nname: ci-fix\n---\nv2", base.id, NOW);
	const run = optimRun(db, { baseArtifactId: base.id, bestArtifactId: best.id, status: "succeeded", holdoutBefore: 0.5, holdoutAfter: 0.8, judgeOnly: false, ...overrides });
	insertOptimCandidate(db, { id: `c-${best.id}`, optimRunId: run.id, artifactId: best.id, parentIds: [], iteration: 1, origin: "reflect", component: "body", minibatch: null, perCase: {}, meanScore: 0.8, meanCostUsd: 0.01, accepted: true, createdAt: NOW });
	return { run, best: best.id, base: base.id };
}

/** Judged, reviewed runs: `agree` of them with the human, `disagree` against. */
function calibrate(db: Db, agree: number, disagree: number): void {
	for (let i = 0; i < agree + disagree; i++) {
		const run = runRow({ status: "succeeded" });
		insertRun(db, run);
		const pass = i % 2 === 0;
		insertScore(db, scoreRow(run.id, { passed: pass, model: JUDGE }));
		const humanDone = i < agree ? pass : !pass;
		recordFeedback(db, { runId: run.id, verdict: humanDone ? "done" : "not_done", nowIso: NOW, redact });
	}
}

describe("sourced artifacts and candidates", () => {
	it("keeps a promoted version while the source is unchanged and lets an edited source win", () => {
		const db = openDb(":memory:");
		const v1 = resolveSourcedArtifact(db, "system_prompt", "default", "prompt A", NOW);
		expect(v1).toMatchObject({ version: 1, origin: "manual", status: "active" });
		expect(resolveSourcedArtifact(db, "system_prompt", "default", "prompt A", NOW).id).toBe(v1.id);
		const cand = insertCandidateArtifact(db, "system_prompt", "default", "prompt B", v1.id, NOW);
		expect(cand).toMatchObject({ version: 2, origin: "gepa", status: "candidate", parentVersionId: v1.id });
		expect(getActiveArtifact(db, "system_prompt", "default")?.id).toBe(v1.id);
		db.prepare("UPDATE artifacts SET status = 'retired' WHERE id = ?").run(v1.id);
		db.prepare("UPDATE artifacts SET status = 'active' WHERE id = ?").run(cand.id);
		expect(resolveSourcedArtifact(db, "system_prompt", "default", "prompt A", NOW).id).toBe(cand.id);
		const edited = resolveSourcedArtifact(db, "system_prompt", "default", "prompt A2", NOW);
		expect(edited).toMatchObject({ version: 3, origin: "manual", status: "active", content: "prompt A2" });
		expect(getArtifact(db, cand.id)?.status).toBe("retired");
	});

	it("stores optimizations and candidates and round-trips their JSON fields", () => {
		const db = openDb(":memory:");
		const run = optimRun(db, { budgetRollouts: 40, merge: true });
		const art = insertCandidateArtifact(db, "skill", "ci-fix", "v2", run.baseArtifactId, NOW);
		insertOptimCandidate(db, { id: "c1", optimRunId: run.id, artifactId: art.id, parentIds: ["c0"], iteration: 2, origin: "reflect", component: "body", minibatch: { caseIds: ["a"], parent: [{ quality: 0, costUsd: 0.1 }], child: [{ quality: 1, costUsd: 0.2 }] }, perCase: {}, meanScore: null, meanCostUsd: null, accepted: false, createdAt: NOW });
		updateOptimCandidate(db, "c1", { accepted: true, perCase: { a: { quality: 1, costUsd: 0.2 } }, meanScore: 1, meanCostUsd: 0.2 });
		updateOptimRun(db, run.id, { spentUsd: 1.5, rollouts: 12, judgeOnly: true, error: { code: "INTERNAL", message: "x", retryable: false } });
		expect(listOptimCandidates(db, run.id)).toEqual([expect.objectContaining({ id: "c1", parentIds: ["c0"], accepted: true, perCase: { a: { quality: 1, costUsd: 0.2 } }, minibatch: expect.objectContaining({ caseIds: ["a"] }) })]);
		expect(getOptimRun(db, run.id)).toMatchObject({ budgetRollouts: 40, merge: true, spentUsd: 1.5, rollouts: 12, judgeOnly: true, error: { code: "INTERNAL" } });
		expect(listOptimRuns(db).map((r) => r.id)).toEqual([run.id]);
		expect(retireOptimCandidates(db, run.id, null)).toBe(1);
		expect(getArtifact(db, art.id)?.status).toBe("retired");
	});

	it("marks an optimization of a dead process aborted and retires its candidates", () => {
		const db = openDb(":memory:");
		const dead = optimRun(db, { pid: 999_999 });
		const alive = optimRun(db, { pid: process.pid });
		const noPid = optimRun(db);
		const cand = insertCandidateArtifact(db, "skill", "ci-fix", "v-dead", dead.baseArtifactId, NOW);
		insertOptimCandidate(db, { id: "cd", optimRunId: dead.id, artifactId: cand.id, parentIds: [], iteration: 1, origin: "reflect", component: "body", minibatch: null, perCase: {}, meanScore: null, meanCostUsd: null, accepted: true, createdAt: NOW });
		expect(recoverCrashedOptimRuns(db, (pid) => pid === process.pid, NOW)).toEqual([dead.id]);
		expect(getOptimRun(db, dead.id)).toMatchObject({ status: "aborted", stopReason: "process_exited", endedAt: NOW });
		expect(getOptimRun(db, alive.id)?.status).toBe("running");
		expect(getOptimRun(db, noPid.id)?.status).toBe("running");
		expect(getArtifact(db, cand.id)?.status).toBe("retired");
		expect(listArtifactVersions(db, "skill", "ci-fix").filter((a) => a.status === "active")).toHaveLength(1);
		expect(getActiveArtifact(db, "skill", "ci-fix")?.origin).toBe("manual");
	});
});

describe("promotion", () => {
	it("refuses unfinished, empty, worse and repeated approvals with CONFLICT", () => {
		const db = openDb(":memory:");
		const running = optimRun(db);
		expect(() => approveOptimRun(db, running.id, { minJudgeKappa: 0.6, nowIso: NOW })).toThrow(/is running, not succeeded/);
		const same = optimRun(db, { status: "succeeded" });
		updateOptimRun(db, same.id, { bestArtifactId: same.baseArtifactId });
		expect(() => approveOptimRun(db, same.id, { minJudgeKappa: 0.6, nowIso: NOW })).toThrow(/found nothing better/);
		const worse = finished(db, { holdoutBefore: 0.7, holdoutAfter: 0.6 });
		const check = checkPromotion(db, getOptimRun(db, worse.run.id) as OptimRunRow, 0.6);
		expect(check).toMatchObject({ allowed: false, error: { code: "CONFLICT" } });
		expect(check.error?.message).toMatch(/worse on the holdout split \(0\.600\).*\(0\.700\)/);
		expect(() => approveOptimRun(db, "nope", { minJudgeKappa: 0.6, nowIso: NOW })).toThrow(/does not exist/);
	});

	it("refuses judge-only promotion below minJudgeKappa and names runs to review", () => {
		const db = openDb(":memory:");
		const { run, best, base } = finished(db, { judgeOnly: true, judgeKey: JUDGE });
		const unreviewed = runRow({ status: "succeeded" });
		insertRun(db, unreviewed);
		insertScore(db, scoreRow(unreviewed.id, { model: JUDGE }));
		const noKappa = checkPromotion(db, run, 0.6);
		expect(noKappa.error).toMatchObject({ code: "FORBIDDEN", context: { kappa: null, runsToReview: [unreviewed.id] } });
		expect(noKappa.error?.message).toMatch(/has no Cohen's κ/);
		expect(noKappa.error?.hint).toContain(unreviewed.id);
		calibrate(db, 2, 2);
		const low = checkPromotion(db, run, 0.6);
		expect(low.error?.message).toMatch(/Cohen's κ 0\.00, below optimize\.minJudgeKappa \(0\.6\)/);
		expect(() => approveOptimRun(db, run.id, { minJudgeKappa: 0.6, nowIso: NOW })).toThrow(/Promotion refused/);
		expect(getArtifact(db, best)?.status).toBe("candidate");
		expect(getActiveArtifact(db, "skill", "ci-fix")?.id).toBe(base);
		calibrate(db, 12, 0);
		expect(checkPromotion(db, run, 0.6)).toMatchObject({ allowed: true, error: null });
		approveOptimRun(db, run.id, { minJudgeKappa: 0.6, nowIso: NOW });
		expect(getActiveArtifact(db, "skill", "ci-fix")?.id).toBe(best);
	});

	it("approves (retiring the previous version) and rolls back to it, once", () => {
		const db = openDb(":memory:");
		const { run, best, base } = finished(db);
		const result = approveOptimRun(db, run.id, { minJudgeKappa: 0.6, nowIso: NOW });
		expect(result.promoted).toMatchObject({ id: best, status: "active" });
		expect(result.replaced).toMatchObject({ id: base, status: "retired" });
		expect(getOptimRun(db, run.id)).toMatchObject({ promotion: "approved", replacedArtifactId: base, promotedAt: NOW });
		expect(() => approveOptimRun(db, run.id, { minJudgeKappa: 0.6, nowIso: NOW })).toThrow(/already approved/);
		const back = rollbackOptimRun(db, run.id, NOW);
		expect(back.active?.id).toBe(base);
		expect(getActiveArtifact(db, "skill", "ci-fix")?.id).toBe(base);
		expect(getArtifact(db, best)?.status).toBe("retired");
		expect(() => rollbackOptimRun(db, run.id, NOW)).toThrow(/not approved/);
	});

	it("refuses approval when the target changed since the optimization started", () => {
		const db = openDb(":memory:");
		const { run, best } = finished(db);
		const edited = appendArtifactVersion(db, "skill", "ci-fix", "---\nname: ci-fix\n---\nedited by hand", "manual", NOW);
		const check = checkPromotion(db, run, 0.6);
		expect(check).toMatchObject({ allowed: false, error: { code: "CONFLICT" } });
		expect(check.error?.message).toMatch(/changed since the optimization started/);
		expect(check.error?.hint).toMatch(/new optimization/);
		expect(() => approveOptimRun(db, run.id, { minJudgeKappa: 0.6, nowIso: NOW })).toThrow(/changed since the optimization started/);
		expect(getArtifact(db, best)?.status).toBe("candidate");
		expect(getActiveArtifact(db, "skill", "ci-fix")?.id).toBe(edited.id);
		expect(getOptimRun(db, run.id)?.promotion).toBeNull();
	});

	it("refuses a rollback once a newer version replaced the promoted one", () => {
		const db = openDb(":memory:");
		const { run } = finished(db);
		approveOptimRun(db, run.id, { minJudgeKappa: 0.6, nowIso: NOW });
		appendArtifactVersion(db, "skill", "ci-fix", "---\nname: ci-fix\n---\nedited by hand", "manual", NOW);
		expect(() => rollbackOptimRun(db, run.id, NOW)).toThrow(/no longer active/);
		expect(getActiveArtifact(db, "skill", "ci-fix")?.content).toContain("edited by hand");
	});
});
