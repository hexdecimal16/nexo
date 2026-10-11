import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { insertRun, insertScore, listCalibrations, openDb, recordFeedback, resolveNexoPaths } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { runRow, scoreRow } from "../../store/test/fixtures.ts";
import { type CliIO, runCli } from "../src/main.ts";

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
function seed(h: { env: NodeJS.ProcessEnv }, cases: [boolean, "done" | "not_done"][]): void {
	const db = openDb(resolveNexoPaths(h.env).db);
	for (const [passed, verdict] of cases) {
		const run = runRow({ status: "succeeded", instruction: `task judged ${passed ? "pass" : "fail"}` });
		insertRun(db, run);
		insertScore(db, scoreRow(run.id, { passed, value: passed ? 0.9 : 0.2, model: "google/gemini-x" }));
		recordFeedback(db, { runId: run.id, verdict, comment: verdict === "not_done" ? "missed it" : "", nowIso: "2026-10-11T00:00:00.000Z", redact: createRedactor() });
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
		seed(h, [[true, "done"]]);
		const t = io();
		expect(await runCli(["eval", "judge", "--judge", "openai/gpt-x"], t, h)).toBe(0);
		expect(t.out()).toContain("Judge openai/gpt-x vs human verdicts");
		expect(t.out()).toContain("No run has both");
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
});
