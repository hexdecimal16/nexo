import { describe, expect, it } from "vitest";
import { holdoutRegression } from "../src/optimize/holdout-gate.ts";

const q = (scores: Record<string, number>) => Object.fromEntries(Object.entries(scores).map(([id, quality]) => [id, { quality, costUsd: 0 }]));

describe("holdoutRegression", () => {
	it("passes a candidate that raises the mean and drops no case too far", () => {
		const gate = holdoutRegression(q({ a: 0.5, b: 0.5 }), q({ a: 0.9, b: 0.4 }), ["a", "b"], 0.2);
		expect(gate.regressed).toBe(false);
		expect(gate.worstDrop).toBeCloseTo(0.1);
		expect(gate.meanDrop).toBeCloseTo(-0.15);
	});

	it("reverts when the holdout mean falls, however slightly", () => {
		expect(holdoutRegression(q({ a: 0.5, b: 0.5 }), q({ a: 0.5, b: 0.45 }), ["a", "b"], 0.2).regressed).toBe(true);
	});

	it("reverts when one case drops more than maxCaseDrop even though the mean rises", () => {
		const gate = holdoutRegression(q({ a: 0.2, b: 0.9 }), q({ a: 1, b: 0.6 }), ["a", "b"], 0.2);
		expect(gate.meanDrop).toBeLessThan(0);
		expect(gate.worstDrop).toBeCloseTo(0.3);
		expect(gate.regressed).toBe(true);
	});

	it("accepts a drop exactly at maxCaseDrop and ignores float noise", () => {
		expect(holdoutRegression(q({ a: 0.1 + 0.2 }), q({ a: 0.3 }), ["a"], 0.2).regressed).toBe(false);
		expect(holdoutRegression(q({ a: 0.5, b: 0.2 }), q({ a: 0.3, b: 0.6 }), ["a", "b"], 0.2).regressed).toBe(false);
	});

	it("counts a missing after-score as 0 and passes an empty holdout", () => {
		expect(holdoutRegression(q({ a: 0.4 }), {}, ["a"], 0.5).regressed).toBe(true);
		expect(holdoutRegression({}, {}, [], 0.2)).toEqual({ regressed: false, meanDrop: 0, worstDrop: 0 });
	});
});
