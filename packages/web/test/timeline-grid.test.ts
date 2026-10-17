import { describe, expect, it } from "vitest";
import { renderTimeline, tickStepMs, type TimelineRow } from "../public/lib/timeline.ts";

const ROW: TimelineRow = { spanId: "s1", label: "run", runId: null, depth: 0, startMs: 0, queuedMs: 0, durationMs: 4000, costUsd: 0, status: "ok", running: true };

describe("tickStepMs", () => {
	it("picks the first round step with at most ten intervals", () => {
		expect(tickStepMs(4000)).toBe(1000);
		expect(tickStepMs(41000)).toBe(5000);
		expect(tickStepMs(60000)).toBe(10000);
		expect(tickStepMs(1e9)).toBe(36e5);
	});
});

describe("renderTimeline grid", () => {
	it("draws a ruler, one gridline per interior tick and a cap on running rows", () => {
		const markup = renderTimeline({ rows: [ROW], originMs: 0, totalMs: 4000 }).value;
		expect(markup).toContain('class="tl-scale"');
		expect(markup).toContain("<span>0s</span><span>");
		expect((markup.match(/class="tl-tick"/g) ?? []).length).toBe(3);
		expect(markup).toContain('class="tl-head"');
	});

	it("leaves finished rows without a cap", () => {
		const markup = renderTimeline({ rows: [{ ...ROW, running: false }], originMs: 0, totalMs: 4000 }).value;
		expect(markup).not.toContain("tl-head");
	});
});
