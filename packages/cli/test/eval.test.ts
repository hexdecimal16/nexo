import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { insertRun, insertScore, JUDGE_CASE_TARGET, listCalibrations, listEvalCases, openDb, recordFeedback, resolveNexoPaths } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { runRow, scoreRow } from "../../store/test/fixtures.ts";
import { type CliIO, escalationLine, runCli, scoreLines } from "../src/main.ts";

function io(): CliIO & { out: () => string; err: () => string } {
	let out = "";
	let err = "";
	return {
		stdout: { write: (s: string) => ((out += s), true) },
		stderr: { write: (s: string) => ((err += s), true) },
		out: () => out,
		err: () => err,
	};
}

const homes: string[] = [];
afterEach(() => {
	for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(config?: unknown): { env: NodeJS.ProcessEnv; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "nexo-cli-eval-"));
	homes.push(root);
	mkdirSync(join(root, "home"), { recursive: true });
	if (config) writeFileSync(join(root, "home", "config.json"), JSON.stringify(config));
	return { env: { NEXO_HOME: join(root, "home") }, cwd: root };
}

const ROLES = { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "fast" } };
const withJudge = { models: { ...ROLES, judge: [{ provider: "google", id: "gemini-x" }] }, providers: { faux: { retryBaseDelayMs: 0 } } };

/** Judged runs with human verdicts: (judge passed, human verdict) per run. */
function seed(h: { env: NodeJS.ProcessEnv }, cases: [boolean, "done" | "not_done"][], model = "google/gemini-x", text?: { instruction: string; comment: string }): void {
	const db = openDb(resolveNexoPaths(h.env).db);
	for (const [passed, verdict] of cases) {
		const run = runRow({ status: "succeeded", instruction: text?.instruction ?? `task judged ${passed ? "pass" : "fail"}` });
		insertRun(db, run);
		insertScore(db, scoreRow(run.id, { passed, value: passed ? 0.9 : 0.2, model }));
		recordFeedback(db, { runId: run.id, verdict, comment: text?.comment ?? (verdict === "not_done" ? "missed it" : ""), nowIso: "2026-10-11T00:00:00.000Z", redact: createRedactor() });
	}
	db.close();
}

describe("nexo eval judge", () => {
	it("prints accuracy, Cohen's kappa, the confusion matrix and disagreements, and stores the calibration", async () => {
		const h = home(withJudge);
		seed(h, [
			[true, "done"],
			[true, "done"],
			[false, "not_done"],
			[true, "not_done"],
		]);
		const t = io();
		expect(await runCli(["eval", "judge"], t, h)).toBe(0);
		expect(t.out()).toContain("Judge google/gemini-x vs human verdicts");
		expect(t.out()).toContain("cases        4");
		expect(t.out()).toContain("agreement    3 (75.0%)");
		expect(t.out()).toContain("Cohen's κ    0.500");
		expect(t.out()).toMatch(/judge pass\s+2\s+1/);
		expect(t.out()).toMatch(/judge fail\s+0\s+1/);
		expect(t.out()).toContain('judge pass, human not done: task judged pass — "missed it"');
		const db = openDb(resolveNexoPaths(h.env).db);
		expect(listCalibrations(db)).toEqual([expect.objectContaining({ judgeKey: "google/gemini-x", cases: 4, agreements: 3, kappa: expect.closeTo(0.5, 10) })]);
		db.close();
	});

	it("stores nothing and explains what to do when no run has both verdicts", async () => {
		const h = home(withJudge);
		const t = io();
		expect(await runCli(["eval", "judge"], t, h)).toBe(0);
		expect(t.out()).toContain("No run has both a score from this judge and a human verdict yet");
		const db = openDb(resolveNexoPaths(h.env).db);
		expect(listCalibrations(db)).toEqual([]);
		db.close();
	});

	it("exits 2 without a configured judge, for an unknown subcommand, and without a config", async () => {
		const noJudge = io();
		expect(await runCli(["eval", "judge"], noJudge, home({ models: ROLES }))).toBe(2);
		expect(noJudge.err()).toContain("No judge is configured");
		const unknown = io();
		expect(await runCli(["eval", "rubric"], unknown, home(withJudge))).toBe(2);
		expect(unknown.err()).toContain('Unknown eval subcommand "rubric"');
		expect(await runCli(["eval", "judge"], io(), home())).toBe(2);
	});

	it("calibrates a judge named with --judge instead of the configured one", async () => {
		const h = home(withJudge);
		seed(h, [[true, "done"], [false, "done"]], "openai/gpt-x");
		seed(h, [[true, "not_done"]], "google/gemini-x");
		const t = io();
		expect(await runCli(["eval", "judge", "--judge", "openai/gpt-x"], t, h)).toBe(0);
		expect(t.out()).toContain("Judge openai/gpt-x vs human verdicts");
		expect(t.out()).toContain("cases        2");
	});

	it("rejects an empty or malformed --judge and an unknown flag with exit 2", async () => {
		for (const argv of [["--judge", ""], ["--judge", "nomodel"], ["--judge", "a/b+c"], ["--judge", "/id"], ["--bogus"]]) {
			const t = io();
			expect(await runCli(["eval", "judge", ...argv], t, home(withJudge))).toBe(2);
		}
	});

	it("prints the one-class text and exits 0 when every verdict is in one class", async () => {
		const h = home(withJudge);
		seed(h, [[true, "done"], [true, "done"]]);
		const t = io();
		expect(await runCli(["eval", "judge"], t, h)).toBe(0);
		expect(t.out()).toContain("cases        2");
		expect(t.out()).toContain("Cohen's κ    – (every verdict is in one class)");
	});

	it("syncs disagreements into judge_rubric eval cases, also when the judge score came after the feedback", async () => {
		const h = home(withJudge);
		const db = openDb(resolveNexoPaths(h.env).db);
		const run = runRow({ status: "succeeded", instruction: "late judged" });
		insertRun(db, run);
		recordFeedback(db, { runId: run.id, verdict: "not_done", comment: "wrong", nowIso: "2026-10-11T00:00:00.000Z", redact: createRedactor() });
		insertScore(db, scoreRow(run.id, { passed: true, model: "google/gemini-x" }));
		expect(listEvalCases(db, JUDGE_CASE_TARGET)).toEqual([]);
		db.close();
		expect(await runCli(["eval", "judge"], io(), h)).toBe(0);
		const after = openDb(resolveNexoPaths(h.env).db);
		expect(listEvalCases(after, JUDGE_CASE_TARGET)).toEqual([expect.objectContaining({ sourceRunId: run.id, expected: "not_done" })]);
		after.close();
	});

	it("escapes control and bidi characters in the judge key, instruction and comment", async () => {
		const h = home(withJudge);
		const bad = { instruction: "do\u001b[31m it\u202e", comment: "line1\nline2\u001b[2J" };
		seed(h, [[true, "not_done"]], "google/gemini-x", bad);
		const t = io();
		expect(await runCli(["eval", "judge"], t, h)).toBe(0);
		expect(t.out()).not.toMatch(/[\u001b\u202e]/);
		expect(t.out()).toContain("\\x1b[31m it\\u202e");
		expect(t.out()).toContain("line1\\x0aline2\\x1b[2J");
		const k = io();
		expect(await runCli(["eval", "judge", "--judge", "a/b\u001b[1m\u202e"], k, h)).toBe(0);
		expect(k.out()).not.toMatch(/[\u001b\u202e]/);
		expect(k.out()).toContain("a/b\\x1b[1m\\u202e");
	});
});

describe("scoreLines", () => {
	it("escapes model-produced text and prints failed scores", () => {
		const base = scoreRow("r");
		const lines = scoreLines({
			scores: [
				{ ...base, scorerName: "n\u001b[1m\u202e", status: "failed", value: null, passed: null, error: { code: "SCORER_FAILED", message: "bad\nline\u001b[2J", retryable: false, hint: "", context: {} } },
				{ ...base, scorerName: "ok", details: { sameFamily: ["x"] } },
			],
			escalations: 2,
		});
		expect(lines.join("\n")).not.toMatch(/[\u001b\u202e]/);
		expect(lines[0]).toBe("  score n\\x1b[1m\\u202e: failed [SCORER_FAILED] bad\\x0aline\\x1b[2J");
		expect(lines[1]).toBe("  score ok: 0.80 ✓ pass (same-family judge)");
		expect(lines[2]).toBe("  escalated to s2 2 times");
	});
});

describe("nexo ui and the judge", () => {
	it("serves the configured judge's calibration and same-family warnings", async () => {
		const h = home({ models: { s1: { provider: "google", id: "gemini-a" }, s2: { provider: "faux", id: "fast" }, judge: [{ provider: "google", id: "gemini-x" }] } });
		seed(h, [[true, "not_done"]]);
		const t = io();
		const ac = new AbortController();
		const running = runCli(["ui", "--port", "0"], t, { ...h, signal: ac.signal });
		for (let i = 0; i < 100 && !t.out().includes("token="); i++) await new Promise((r) => setTimeout(r, 10));
		const url = /nexo UI: (\S+)/.exec(t.out())?.[1] ?? "";
		const body = (await (await fetch(new URL("/api/judge/calibration", url))).json()) as { judgeKey: string; warnings: string[]; current: { cases: number } };
		expect(body.judgeKey).toBe("google/gemini-x");
		expect(body.warnings).toEqual([expect.stringContaining("same model family (google) as google/gemini-a")]);
		expect(body.current.cases).toBe(1);
		ac.abort();
		expect(await running).toBe(0);
	});
});

describe("nexo run with scorers", () => {
	it("prints each score and the escalation count after the run", async () => {
		const h = home({ models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "strong" } }, providers: { faux: { retryBaseDelayMs: 0 } }, scoring: { scorers: [{ kind: "contains", name: "says-done", text: "DONE" }] } });
		const faux = fauxProvider({ models: [{ id: "fast", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, { id: "strong", cost: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0 } }] });
		faux.setResponses([fauxAssistantMessage("not yet"), fauxAssistantMessage("DONE")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const t = io();
		expect(await runCli(["run", "finish", "--no-review"], t, { ...h, models })).toBe(0);
		expect(t.err()).toContain("↑ escalating to faux/strong (verify_fail: deterministic scorer failed: says-done)");
		expect(t.err()).toContain("  score says-done: 1.00 ✓ pass");
		expect(t.err()).toContain("  escalated to s2 once");
	});

	it("escapes control characters in the escalation line", () => {
		const line = escalationLine(1, "faux/s\u001b[1m", "verify_fail", "reason\nx\u202e");
		expect(line).not.toMatch(/[\u001b\u202e]/);
		expect(line).toBe("\n    ↑ escalating to faux/s\\x1b[1m (verify_fail: reason\\x0ax\\u202e)\n");
	});
});
