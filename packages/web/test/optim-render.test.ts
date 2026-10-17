import { describe, expect, it } from "vitest";
import type { OptimCandidate, OptimDetailResponse, OptimReport, OptimRunItem } from "../public/lib/api-types.ts";
import { optimQuery, renderApproval, renderDiff, renderLineage, renderOptimDetail, renderOptimList, renderProposedCases } from "../public/lib/optim-view.ts";

const XSS = `<img src=x onerror="alert(1)"><script>alert('x')</script>\``;

function expectInert(markup: string): void {
	expect(markup).not.toContain("<script");
	expect(markup).not.toContain("<img");
	expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
}

function run(overrides: Partial<OptimRunItem> = {}): OptimRunItem {
	return {
		id: "01OPTIM",
		target: "skill:ci-fix",
		status: "succeeded",
		stopReason: "patience",
		budgetUsd: 2,
		budgetRollouts: null,
		spentUsd: 0.4,
		rollouts: 30,
		merge: false,
		seed: 7,
		baseArtifactId: "a1",
		bestArtifactId: "a2",
		dirPath: "/x",
		reportRef: "report.json",
		judgeKey: "google/gemini-x",
		judgeOnly: true,
		holdoutBefore: 0.3,
		holdoutAfter: 0.9,
		promotion: null,
		replacedArtifactId: null,
		promotedAt: null,
		pid: null,
		error: null,
		createdAt: "2026-10-12T00:00:00.000Z",
		endedAt: "2026-10-12T00:10:00.000Z",
		mode: "gepa",
		caseId: null,
		climbOutcome: null,
		baseVersion: 1,
		bestVersion: 3,
		...overrides,
	};
}

const candidate = (overrides: Partial<OptimCandidate> = {}): OptimCandidate => ({
	id: "01CANDIDATE1",
	optimRunId: "01OPTIM",
	artifactId: "a2",
	parentIds: ["01CANDIDATE0"],
	iteration: 1,
	origin: "reflect",
	component: "body",
	minibatch: { caseIds: ["c"], parent: [{ quality: 0.2, costUsd: 0.01 }], child: [{ quality: 0.8, costUsd: 0.01 }] },
	perCase: {},
	meanScore: 0.9,
	meanCostUsd: 0.02,
	accepted: true,
	createdAt: "2026-10-12T00:01:00.000Z",
	version: 3,
	artifactStatus: "candidate",
	...overrides,
});

const report: OptimReport = {
	optimRunId: "01OPTIM",
	target: "skill:ci-fix",
	baseArtifactId: "a1",
	bestArtifactId: "a2",
	improved: true,
	holdout: { cases: [{ caseId: "h1", input: `Fix ${XSS}`, before: { quality: 0.3, costUsd: 0.01 }, after: { quality: 0.9, costUsd: 0.02 }, outcome: "win" }], before: { quality: 0.3, costUsd: 0.01 }, after: { quality: 0.9, costUsd: 0.02 }, wins: 1, losses: 0, ties: 0 },
	diff: [
		{ op: "same", text: "Run the linter." },
		{ op: "add", text: `Then ${XSS}` },
		{ op: "del", text: "Stop." },
	],
	lineage: [],
	evidence: { judgeOnly: true, humanScored: false, judgeKey: "google/gemini-x", kappa: 0.4, minJudgeKappa: 0.6 },
	stopReason: "patience",
	spentUsd: 0.4,
	rollouts: 30,
	iterations: 6,
	merges: 0,
	mergeNote: "skill:ci-fix has one component, so no merge is possible",
	createdAt: "2026-10-12T00:10:00.000Z",
};

function detail(overrides: Partial<OptimDetailResponse> = {}): OptimDetailResponse {
	return { run: run(), candidates: [candidate({ id: "01CANDIDATE0", origin: "seed", parentIds: [], minibatch: null, version: 1, artifactStatus: "active" }), candidate()], report, promotion: { allowed: true, error: null, kappa: 0.7 }, ...overrides };
}

describe("optimization view", () => {
	it("lists optimizations with their holdout quality, versions and an open button", () => {
		const markup = renderOptimList([run({ target: `skill:${XSS}` })]).value;
		expect(markup).toContain('data-optim="01OPTIM"');
		expect(markup).toContain("0.300 → 0.900");
		expect(markup).toContain("v1 → v3");
		expectInert(markup);
		expect(renderOptimList([]).value).toContain("nexo optimize --target");
	});

	it("shows the holdout report, the diff, the lineage and an Approve button when allowed", () => {
		const markup = renderOptimDetail(detail(), false).value;
		expect(markup).toContain("Holdout report");
		expect(markup).toContain('<span class="badge outcome-win">win</span>');
		expect(markup).toContain('data-approve="01OPTIM"');
		expect(markup).toContain('<span class="diff-add">+ Then');
		expect(markup).toContain('<span class="diff-del">- Stop.</span>');
		expect(markup).toContain("0.200 → 0.800");
		expect(markup).toContain("one component, so no merge is possible");
		expect(markup).toContain("<strong>judge only</strong>");
		expectInert(markup);
		expect(renderOptimDetail(detail(), true).value).not.toContain("data-approve");
		expect(renderDiff([{ op: "same", text: "x" }]).value).toContain("is the starting text");
		expect(renderLineage([candidate({ parentIds: [], minibatch: null, meanScore: null })]).value).toContain("–");
	});

	it("renders a climb report inertly with readable winners", () => {
		const climb = { caseId: "01CASE", guardIds: ["01G"], outcome: "improved" as const, critique: `Run ${XSS}`, comparisons: [{ label: "golden", winner: "B" as const, votes: [] }, { label: "verify", winner: "A" as const, votes: [] }, { label: "guard 01G", winner: "tie" as const, votes: [] }] };
		const markup = renderOptimDetail(detail({ report: { ...report, climb } }), false).value;
		expect(markup).toContain("golden preferred");
		expect(markup).toContain("child preferred");
		expect(markup).toContain("<td>tie</td>");
		expectInert(markup);
	});

	it("explains a refused approval and links the runs to review", () => {
		const refused = detail({
			promotion: {
				allowed: false,
				kappa: 0.4,
				error: { code: "FORBIDDEN", message: `Promotion refused: ${XSS}`, retryable: false, hint: "Review these judged runs", context: { runsToReview: ["01RUNA", "01RUNB"] } },
			},
		});
		const markup = renderApproval(refused, false).value;
		expect(markup).toContain("Cannot approve");
		expect(markup).toContain('href="/run.html?id=01RUNA"');
		expect(markup).toContain("Cohen's κ 0.40 (minimum 0.6)");
		expect(markup).not.toContain("data-approve");
		expectInert(markup);
		expect(renderApproval(detail({ run: run({ promotion: "approved", promotedAt: "2026-10-12T01:00:00.000Z" }) }), false).value).toContain("nexo optimize rollback 01OPTIM");
		expect(renderOptimDetail(detail({ report: null, run: run({ status: "running" }) }), false).value).toContain("still running");
	});
});

it("renders proposed cases escaped, with buttons only when writable", () => {
	const cases = [{ id: "01M", target: "skill:x", input: "<script>alert(1)</script>", origin: "mined" as const, status: "proposed" as const, clusterSize: 4, createdAt: "2026-10-16T00:00:00.000Z" }];
	const writable = renderProposedCases(cases, false).value;
	expect(writable).toContain("&lt;script&gt;");
	expect(writable).toContain('data-accept="01M"');
	expect(writable).toContain('data-dismiss="01M"');
	expect(renderProposedCases(cases, true).value).not.toContain("data-accept");
	expect(renderProposedCases([], false).value).toContain("No proposed eval cases");
});

it("renders the empty proposed-cases state as a muted line, like the runs list", () => {
	expect(renderProposedCases([], false).value).toContain('<p class="muted">No proposed eval cases');
});

it("asks for a page of optimizations by offset", () => {
	expect(optimQuery({ offset: 0, limit: 25 })).toBe("/api/optim?limit=25");
	expect(optimQuery({ offset: 50, limit: 25 })).toBe("/api/optim?limit=25&offset=50");
});
