import { describe, expect, it } from "vitest";
import type { Escalation, JudgeCalibrationResponse, Score } from "../public/lib/api-types.ts";
import { renderCalibration } from "../public/lib/judge-view.ts";
import { renderEscalations, renderScoreCell, renderScores } from "../public/lib/score-view.ts";

const XSS = `<img src=x onerror="alert(1)"><script>alert('x')</script>\``;

function expectInert(markup: string): void {
	expect(markup).not.toContain("<script");
	expect(markup).not.toContain("<img");
	expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
}

function score(overrides: Partial<Score> = {}): Score {
	return {
		id: "s1",
		runId: "r1",
		round: 0,
		scorerKind: "judge",
		scorerType: "llm_judge",
		scorerName: "llm_judge",
		status: "ok",
		value: 0.82,
		passed: true,
		rationale: `Good ${XSS}`,
		criteria: [{ name: "correct", passed: false, note: XSS }],
		details: {},
		error: null,
		model: "google/gemini-x",
		costUsd: 0.0012,
		costUnknown: false,
		createdAt: "2026-10-11T00:00:00.000Z",
		...overrides,
	};
}

describe("score views", () => {
	it("renders the runs-list score cell", () => {
		expect(renderScoreCell(null).value).toContain("–");
		expect(renderScoreCell({ value: 0.82, passed: true, scorers: 2, failedScorers: 0 }).value).toContain("0.82 ✓");
		expect(renderScoreCell({ value: 0.4, passed: false, scorers: 1, failedScorers: 1 }).value).toMatch(/0\.40 ✗.*\+1 failed/);
		expect(renderScoreCell({ value: null, passed: null, scorers: 0, failedScorers: 2 }).value).toContain("failed");
	});

	it("shows a neutral mark for a score with no pass/fail verdict", () => {
		const cell = renderScoreCell({ value: 0.5, passed: null, scorers: 1, failedScorers: 0 }).value;
		expect(cell).toContain("0.50 –");
		expect(cell).not.toContain("✗");
		const panel = renderScores([score({ value: 0.5, passed: null, criteria: [] })], null, false).value;
		expect(panel).toContain('<span class="badge score-neutral">0.50 –</span>');
		expect(panel).not.toContain("fail");
	});

	it("renders the judge reasoning panel escaped, with criteria, votes and the same-family badge", () => {
		const markup = renderScores(
			[
				score({
					scorerName: XSS,
					details: {
						sameFamily: [{ judge: "anthropic/claude-x", generator: "anthropic/claude-y", family: "anthropic" }],
						votes: [
							{ model: "google/gemini-x", score: 0.9, passed: true },
							{ model: "openai/gpt-x", score: null, passed: null, error: XSS },
						],
					},
				}),
			],
			null,
			false,
		).value;
		expectInert(markup);
		expect(markup).toContain("0.82 pass");
		expect(markup).toContain("✗ <strong>correct</strong>");
		expect(markup).toContain("same-family judge");
		expect(markup).toContain("openai/gpt-x</span> <span class=\"warn\">failed:");
		expect(markup).not.toContain("Human verdict");
	});

	it("puts the human verdict first, flags a disagreement, and collapses earlier rounds", () => {
		const markup = renderScores([score({ round: 0, value: 0.3, passed: false }), score({ id: "s2", round: 1, value: 0.9 })], "not_done", true).value;
		expect(markup.indexOf("Human verdict")).toBeLessThan(markup.indexOf("0.90 pass"));
		expect(markup).toContain("judge disagrees");
		expect(markup).toContain("<details class=\"score-round\"><summary>Round 0 (before escalation 1)</summary>");
	});

	it("renders a failed scorer with its error and an empty state", () => {
		const markup = renderScores([score({ status: "failed", value: null, passed: null, rationale: "", error: { code: "SCORER_FAILED", message: XSS, retryable: false, hint: "Use another judge" } })], null, false).value;
		expectInert(markup);
		expect(markup).toContain("<strong>SCORER_FAILED</strong>");
		expect(markup).toContain("Use another judge");
		expect(renderScores([], null, false).value).toContain("No scorer ran");
	});

	it("renders applied and suppressed escalations", () => {
		const base: Escalation = { spanId: "e", at: "2026-10-11T00:00:00.000Z", trigger: "tool_failures", reason: XSS, phase: "mid_run", applied: true, blockedBy: null, blockedReason: null, continuationError: null, from: "faux/fast", to: "faux/slow" };
		const markup = renderEscalations([base, { ...base, trigger: "judge_low", applied: false, blockedBy: "budget_cutoff", phase: "end_of_run" }]).value;
		expectInert(markup);
		expect(markup).toContain("faux/fast → <span class=\"mono\">faux/slow</span>");
		expect(markup).toContain("suppressed: budget_cutoff");
		expect(markup).toContain('<span class="kind">mid-run</span>');
		expect(markup).toContain('<span class="kind">end-of-run</span>');
		const detailed = renderEscalations([{ ...base, applied: false, blockedBy: "budget_cutoff", blockedReason: XSS, continuationError: { code: "MODEL_FAILED", message: XSS } }]).value;
		expectInert(detailed);
		expect(detailed).toContain("blocked: ");
		expect(detailed).toContain("continuation failed: <strong>MODEL_FAILED</strong>");
		expect(renderEscalations([]).value).toContain("stayed on its model");
	});
});

describe("calibration view", () => {
	const data: JudgeCalibrationResponse = {
		judgeKey: "google/gemini-x",
		warnings: [`Judge ${XSS}`],
		current: { cases: 4, agreements: 3, accuracy: 0.75, kappa: 0.5, matrix: { bothPass: 2, judgePassHumanFail: 1, judgeFailHumanPass: 0, bothFail: 1 } },
		history: [{ id: "c1", judgeKey: "google/gemini-x", cases: 4, agreements: 3, accuracy: 0.75, kappa: 0.5, matrix: { bothPass: 2, judgePassHumanFail: 1, judgeFailHumanPass: 0, bothFail: 1 }, createdAt: "2026-10-11T00:00:00.000Z" }],
		disagreements: [{ runId: "r&1", instruction: XSS, judgePassed: true, verdict: "not_done", comment: "missed" }],
	};

	it("shows agreement, kappa, the matrix, history and linked disagreements, escaped", () => {
		const markup = renderCalibration(data).value;
		expectInert(markup);
		expect(markup).toContain("accuracy 75.0%");
		expect(markup).toContain("Cohen's κ 0.500");
		expect(markup.replace(/<[^>]+>/g, "")).toContain("4 cases · accuracy 75.0% · Cohen's κ 0.500");
		expect(markup).toContain("<th>judge pass</th><td class=\"num\">2</td><td class=\"num\">1</td>");
		expect(markup).toContain('href="/run.html?id=r%261"');
		expect(markup).toContain("same-family judge");
	});

	it("explains the empty states", () => {
		const empty = renderCalibration({ judgeKey: null, warnings: [], current: null, history: [], disagreements: [] }).value;
		expect(empty).toContain("No judge is configured");
		expect(empty).toContain("nexo eval judge");
		expect(empty).toContain("agrees with every human verdict");
		expect(renderCalibration({ ...data, current: { ...data.current!, cases: 0 } }).value).toContain("No run has both a score from this judge and a human verdict yet");
	});
});
