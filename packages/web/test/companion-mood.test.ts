import { describe, expect, it } from "vitest";
import type { RunSummary } from "../public/lib/api-types.ts";
import { ago, deriveMood, MOUTHS, transitions } from "../public/lib/companion-mood.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const MIN = 60_000;

function run(id: string, status: string, endedMinAgo: number | null, instruction = `task ${id}`): RunSummary {
	const ended = endedMinAgo === null ? null : new Date(NOW - endedMinAgo * MIN).toISOString();
	return { id, status, instruction, startedAt: new Date(NOW - (endedMinAgo ?? 1) * MIN - MIN).toISOString(), endedAt: ended } as unknown as RunSummary;
}

describe("companion mood", () => {
	it("is working while a run is running, naming a single run", () => {
		const state = deriveMood([run("a", "running", null, "write the release notes"), run("b", "failed", 2)], NOW);
		expect(state.mood).toBe("working");
		expect(state.line).toContain("write the release notes");
		expect(state.lastFailed?.id).toBe("b");
		expect(deriveMood([run("a", "running", null), run("c", "running", null)], NOW).line).toContain("2 runs");
	});

	it("worries about a recent failure and is happy about a recent success", () => {
		expect(deriveMood([run("a", "succeeded", 30), run("b", "budget_exceeded", 5)], NOW).mood).toBe("worried");
		expect(deriveMood([run("a", "succeeded", 3), run("b", "failed", 30)], NOW).mood).toBe("happy");
	});

	it("settles to idle, then sleeps after long quiet or with no runs", () => {
		expect(deriveMood([run("a", "succeeded", 40)], NOW).mood).toBe("idle");
		expect(deriveMood([run("a", "failed", 120)], NOW).mood).toBe("idle");
		expect(deriveMood([run("a", "succeeded", 300)], NOW).mood).toBe("sleepy");
		expect(deriveMood([], NOW).mood).toBe("sleepy");
	});

	it("clips long instructions and has a mouth for every mood", () => {
		const state = deriveMood([run("a", "running", null, "x".repeat(200))], NOW);
		expect(state.line.length).toBeLessThan(70);
		for (const mood of ["working", "happy", "worried", "idle", "sleepy"] as const) expect(MOUTHS[mood]).toMatch(/^M/);
	});

	it("counts runs that finished since the last poll", () => {
		const moved = transitions(new Set(["a", "b", "c"]), [run("a", "succeeded", 0), run("b", "failed", 0), run("c", "running", null), run("d", "succeeded", 0)]);
		expect(moved).toEqual({ succeeded: 1, failed: 1 });
	});

	it("formats elapsed time", () => {
		expect(ago(10_000)).toBe("just now");
		expect(ago(5 * MIN)).toBe("5m ago");
		expect(ago(3 * 60 * MIN)).toBe("3h ago");
		expect(ago(72 * 60 * MIN)).toBe("3d ago");
	});
});
