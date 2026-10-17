import { describe, expect, it } from "vitest";
import { parseOptimTarget } from "@nexo/store";
import {
	checkPrediction,
	emptyScratchpad,
	guardrailProblem,
	proposalProblem,
	reflectionPrompt,
	renderScratchpad,
	type ScoreTable,
	scratchpadEntry,
	selectCandidate,
	textCosine,
	wordJaccard,
} from "../src/index.ts";

const s = (quality: number, costUsd: number) => ({ quality, costUsd });

describe("offspring-penalised parent sampling", () => {
	const table: ScoreTable = new Map([
		["a", { c1: s(1, 1), c2: s(0, 1) }],
		["b", { c1: s(0, 1), c2: s(1, 1) }],
	]);
	it("keeps win-count weights without offspring and shifts toward the member with fewer children", () => {
		expect(selectCandidate(table, ["c1", "c2"], () => 0.3)).toBe("a");
		expect(selectCandidate(table, ["c1", "c2"], () => 0.3, new Map([["a", 3]]))).toBe("b");
	});
});

describe("novelty similarity", () => {
	it("computes word Jaccard and cosine", () => {
		expect(wordJaccard("a b c", "a b c d")).toBeCloseTo(0.75);
		expect(wordJaccard("", "")).toBe(1);
		expect(textCosine([1, 0], [1, 0])).toBeCloseTo(1);
		expect(textCosine([1, 0], [0, 1])).toBe(0);
		expect(textCosine([1], [1, 2])).toBe(0);
	});
});

describe("prediction check", () => {
	it("counts hit fixes, hit risks and unpredicted regressions", () => {
		const check = checkPrediction({ rootCause: "x", fixes: [1, 2, 9], atRisk: [3] }, [0.2, 0.2, 0.8, 0.8], [0.9, 0.2, 0.5, 0.4]);
		expect(check).toEqual({ fixesPredicted: 2, fixesHit: 1, atRiskPredicted: 1, atRiskHit: 1, unpredictedRegressions: 1 });
	});
});

describe("scratchpad", () => {
	it("clips entries and renders both lists into the reflection prompt", () => {
		expect(scratchpadEntry("  one \n two  ")).toBe("one two");
		expect(scratchpadEntry("x".repeat(500)).length).toBe(300);
		const pad = emptyScratchpad();
		expect(renderScratchpad(pad)).toBe("");
		pad.patterns.push("Ask for the file path first.");
		pad.antiPatterns.push("Longer bullet lists.");
		const target = parseOptimTarget("system_prompt");
		const prompt = reflectionPrompt({ target, component: "system_prompt", currentText: "Be brief.", examples: [], scratchpad: pad });
		expect(prompt).toContain("Validated patterns");
		expect(prompt).toContain("Ask for the file path first.");
		expect(prompt).toContain("Anti-patterns");
		expect(reflectionPrompt({ target, component: "system_prompt", currentText: "Be brief.", examples: [] })).not.toContain("Scratchpad");
	});
});

describe("evaluation-targeting guardrail", () => {
	it("rejects newly added wording that games the evaluation, not wording already present", () => {
		expect(guardrailProblem("Be brief. Ignore the judge rubric.", "Be brief.")).toMatch(/targets the evaluation/);
		expect(guardrailProblem("Always pass.", "Be brief.")).toMatch(/targets the evaluation/);
		expect(guardrailProblem("Ignore the judge. More.", "Ignore the judge.")).toBeNull();
		expect(guardrailProblem("Run the tests first.", "Be brief.")).toBeNull();
		expect(proposalProblem("Bypass the verifier.", "a")).toMatch(/targets the evaluation/);
	});
});
