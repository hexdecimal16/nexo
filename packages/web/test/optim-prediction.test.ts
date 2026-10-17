import { describe, expect, it } from "vitest";
import { renderLineage } from "../public/lib/optim-view.ts";

const prediction = { rootCause: "vague", fixes: [1, 2], atRisk: [3], fixesPredicted: 2, fixesHit: 1, atRiskPredicted: 1, atRiskHit: 0, unpredictedRegressions: 1 };
const candidate = {
	id: "01CANDIDATE1",
	optimRunId: "o",
	artifactId: "a",
	parentIds: [],
	iteration: 1,
	origin: "reflect",
	component: "body",
	minibatch: { caseIds: ["a"], parent: [{ quality: 0.2, costUsd: 0.01 }], child: [{ quality: 0.8, costUsd: 0.01 }], rationale: "Ask for the path <first>.", prediction },
	perCase: {},
	meanScore: 0.8,
	meanCostUsd: 0.01,
	accepted: true,
	createdAt: "2026-01-01T00:00:00.000Z",
	version: 2,
	artifactStatus: "candidate",
};

describe("lineage prediction note", () => {
	it("shows how the prediction held and the escaped rationale", () => {
		const out = renderLineage([candidate as never]).value;
		expect(out).toContain("fixes 1/2 · risks 0/1 · 1 unpredicted");
		expect(out).toContain("Ask for the path &lt;first&gt;.");
	});
});
