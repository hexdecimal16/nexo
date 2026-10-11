import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { listScores, listSpans, readRunJson } from "@nexo/store";
import { createEngine, createSession, type EngineEvent, judgeFamilyWarnings } from "../src/index.ts";
import { JUDGE, judgeEnv, judges, route, skillMd, verdict } from "./scoring-helpers.ts";

describe("LLM judge at the end of a run", () => {
	it("scores the final output, charges the judge call to the run and records it everywhere", async () => {
		const env = judgeEnv({ config: JUDGE });
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		const r = route(env, [fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "x" })]), fauxAssistantMessage("The answer is 42.")], [verdict(0.9)]);
		const result = await createEngine(env.deps).run({ instruction: "What is six times seven?" });

		expect(result.status).toBe("succeeded");
		expect(result.scores).toEqual([expect.objectContaining({ scorerType: "llm_judge", scorerKind: "judge", status: "ok", value: 0.9, passed: true, model: "faux/gemini-judge" })]);
		expect(r.prompts[0]).toContain("# Final output\n<<<nexo:data:final_output>>>\nThe answer is 42.\n<<<nexo:end:final_output>>>");
		expect(r.prompts[0]).toContain("✓ write");
		expect(r.prompts[0]).toContain("Files changed: a.txt");
		const runId = result.trajectoryId as string;
		const spans = listSpans(env.deps.db, runId);
		const judgeSpan = spans.find((s) => s.kind === "judge_call");
		expect(judgeSpan).toMatchObject({ tier: "judge", model: "gemini-judge", status: "ok" });
		expect(judgeSpan?.costUsd).toBeGreaterThan(0);
		expect(spans.find((s) => s.kind === "scorer")).toMatchObject({ name: "llm_judge", status: "ok" });
		const llmCost = spans.filter((s) => s.kind === "llm_call" || s.kind === "judge_call").reduce((sum, s) => sum + s.costUsd, 0);
		expect(result.costUsd).toBeCloseTo(llmCost, 10);
		expect(listScores(env.deps.db, runId)).toHaveLength(1);
		const runJson = readRunJson(result.runDir as string);
		expect(runJson.scores?.[0]).toMatchObject({ value: 0.9, passed: true });
		expect(readdirSync(join(result.runDir as string, "scores", "round-0"))).toEqual(["llm_judge-faux_gemini-judge.json"]);
		expect(existsSync(join(result.runDir as string, "artifacts", "judge_rubric.md"))).toBe(true);
		expect(events.filter((e) => e.type === "score")).toEqual([expect.objectContaining({ scorer: "llm_judge", value: 0.9, passed: true, status: "ok" })]);
	});

	it("records SCORER_FAILED when the judge output fails the schema twice, and the run still succeeds", async () => {
		const env = judgeEnv({ config: JUDGE });
		route(env, [fauxAssistantMessage("Done.")], ["I think it is fine.", JSON.stringify({ score: 7, criteria: [], rationale: "" })]);
		const result = await createEngine(env.deps).run({ instruction: "Do it" });

		expect(result.status).toBe("succeeded");
		const [row] = listScores(env.deps.db, result.trajectoryId as string);
		expect(row).toMatchObject({ status: "failed", value: null, passed: null, error: { code: "SCORER_FAILED" } });
		expect(row?.error?.message).toContain("returned invalid output twice");
		expect(row?.costUsd).toBeGreaterThan(0);
		const calls = listSpans(env.deps.db, result.trajectoryId as string).filter((s) => s.kind === "judge_call");
		expect(calls.map((s) => s.attrs.purpose)).toEqual(["score", "score-repair"]);
		expect(readdirSync(join(result.runDir as string, "scores", "round-0"))).toEqual(["llm_judge-faux_gemini-judge.json"]);
	});

	it("accepts a reply that the repair request fixes", async () => {
		const env = judgeEnv({ config: JUDGE });
		const r = route(env, [fauxAssistantMessage("Done.")], ["not json", `Sure: ${verdict(0.7)}`]);
		const result = await createEngine(env.deps).run({ instruction: "Do it" });
		expect(result.scores?.[0]).toMatchObject({ status: "ok", value: 0.7 });
		expect(result.scores?.[0]?.details.votes).toEqual([expect.objectContaining({ repaired: true })]);
		expect(r.prompts[1]).toContain("Your previous reply was invalid");
	});

	it("combines a panel by majority, breaking a tie with the mean score", async () => {
		const env = judgeEnv({ config: judges("gemini-judge", "gpt-judge") });
		route(env, [fauxAssistantMessage("Done.")], [verdict(0.9, "good"), verdict(0.3, "weak")]);
		const result = await createEngine(env.deps).run({ instruction: "Do it" });
		const score = result.scores?.[0];
		expect(score).toMatchObject({ status: "ok", passed: true, model: "faux/gemini-judge+faux/gpt-judge" });
		expect(score?.value).toBeCloseTo(0.6);
		expect(score?.details.panel).toBe(true);
		expect(score?.rationale).toContain("[faux/gemini-judge] good");
	});

	it("reserves each panel member's estimate, so parallel judge calls never overspend the run budget", async () => {
		const env = judgeEnv({
			config: {
				...judges("gemini-judge", "gpt-judge"),
				budgets: { estimateOutputTokens: 1000 },
				pricingOverrides: { "faux/fast": { input: 0, output: 0 }, "faux/gemini-judge": { input: 0, output: 600 }, "faux/gpt-judge": { input: 0, output: 600 } },
			},
		});
		route(env, [fauxAssistantMessage("Done.")], [verdict(0.9)]);
		// Each judge call is estimated at $0.60; the $1 budget fits one of the two parallel calls.
		const result = await createEngine(env.deps).run({ instruction: "Do it", budgetUsd: 1 });
		expect(result.status).toBe("succeeded");
		expect(result.costUsd).toBeLessThanOrEqual(1);
		const score = result.scores?.[0];
		expect(score).toMatchObject({ status: "ok", value: 0.9, passed: true });
		expect(score?.details.votes).toEqual([
			expect.objectContaining({ model: "faux/gemini-judge", score: 0.9 }),
			expect.objectContaining({ model: "faux/gpt-judge", score: null, error: expect.stringContaining("cannot cover the judge call") }),
		]);
		expect(listSpans(env.deps.db, result.trajectoryId as string).filter((s) => s.kind === "judge_call")).toHaveLength(1);
	});

	it("flags a judge from the generator's family on the score and at startup", async () => {
		const env = judgeEnv({ config: judges("slow") });
		route(env, [fauxAssistantMessage("Done."), fauxAssistantMessage(verdict(0.8))]);
		const result = await createEngine(env.deps).run({ instruction: "Do it" });
		expect(result.scores?.[0]?.details.sameFamily).toEqual([{ judge: "faux/slow", generator: "faux/fast", family: "faux" }]);
		expect(judgeFamilyWarnings(env.deps.config)).toEqual([expect.stringContaining("Judge faux/slow is from the same model family (faux) as faux/fast")]);
	});

	it("does not score subagent runs unless scoring.subagents is set", async () => {
		const env = judgeEnv({ config: JUDGE });
		route(
			env,
			[fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "a", instruction: "child task" }] })]), fauxAssistantMessage("child done"), fauxAssistantMessage("parent done")],
			[verdict(0.9)],
		);
		const result = await createEngine(env.deps).run({ instruction: "Fan out" });
		expect(result.status).toBe("succeeded");
		const childId = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "subagent")?.attrs.trajectoryId as string;
		expect(listScores(env.deps.db, childId)).toEqual([]);
		expect(listScores(env.deps.db, result.trajectoryId as string)).toHaveLength(1);
	});

	it("records a refused judge call as a failed score when the run budget is spent", async () => {
		const env = judgeEnv({ config: { ...JUDGE, budgets: { estimateOutputTokens: 1 }, pricingOverrides: { "faux/gemini-judge": { input: 1_000_000, output: 0 } } } });
		route(env, [fauxAssistantMessage("Done.")], []);
		const result = await createEngine(env.deps).run({ instruction: "Do it", budgetUsd: 0.5 });
		expect(result.status).toBe("succeeded");
		expect(result.scores?.[0]).toMatchObject({ status: "failed", error: { code: "SCORER_FAILED" } });
		expect(result.scores?.[0]?.error?.message).toContain("cannot cover the judge call");
	});

	it("ends the run aborted, without a score row, when it is aborted during the judge call", async () => {
		const env = judgeEnv({ config: JUDGE });
		const controller = new AbortController();
		env.faux.setResponses([
			fauxAssistantMessage("Done."),
			async () => {
				controller.abort();
				return fauxAssistantMessage(verdict(0.9));
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "Do it" }, controller.signal);
		expect(result.status).toBe("aborted");
		expect(result.scores).toBeUndefined();
		expect(listScores(env.deps.db, result.trajectoryId as string)).toEqual([]);
		expect(listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "scorer")).toMatchObject({ status: "error" });
	});

	it("stores the judge rationale, criteria and replies redacted", async () => {
		const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";
		const env = judgeEnv({ config: JUDGE });
		route(env, [fauxAssistantMessage("Done.")], [verdict(0.9, `quoted ${secret}`)]);
		const result = await createEngine(env.deps).run({ instruction: "Do it" });
		const [row] = listScores(env.deps.db, result.trajectoryId as string);
		expect(row?.rationale).toBe("quoted [REDACTED]");
		expect(JSON.stringify(result.scores)).not.toContain(secret);
		expect(readFileSync(join(result.runDir as string, "run.json"), "utf8")).not.toContain(secret);
		expect(readFileSync(join(result.runDir as string, "scores", "round-0", "llm_judge-faux_gemini-judge.json"), "utf8")).not.toContain(secret);
	});
});

describe("deterministic scorers", () => {
	it("runs a skill's command scorer in the run workspace", async () => {
		const env = judgeEnv({ skills: { "make-file": skillMd("make-file", { "nexo-scorers": "scorers.json" }) } });
		writeFileSync(join(env.deps.paths.skills, "make-file", "scorers.json"), JSON.stringify({ scorers: [{ kind: "command", name: "has-file", command: "test -f out.txt && echo found" }] }));
		route(env, [fauxAssistantMessage([fauxToolCall("write", { path: "out.txt", content: "hi" })]), fauxAssistantMessage("Wrote it.")]);
		const result = await createEngine(env.deps).run({ instruction: "Make the file", skill: "make-file" });
		expect(result.scores).toEqual([expect.objectContaining({ scorerName: "has-file", scorerType: "command", passed: true, value: 1 })]);
		expect(result.scores?.[0]?.rationale).toContain("exit code 0\nfound");
		expect(readFileSync(join(result.runDir as string, "scores", "round-0", "has-file.log"), "utf8")).toContain("$ test -f out.txt");
	});

	it("stores command scorer output redacted", async () => {
		const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";
		const env = judgeEnv({ config: { scoring: { scorers: [{ kind: "command", name: "leaky", command: `echo ${secret}` }] } } });
		route(env, [fauxAssistantMessage("Done.")]);
		const result = await createEngine(env.deps).run({ instruction: "Do it" });
		expect(result.scores?.[0]).toMatchObject({ scorerName: "leaky", status: "ok" });
		expect(listScores(env.deps.db, result.trajectoryId as string)[0]?.rationale).toContain("[REDACTED]");
		expect(JSON.stringify(listScores(env.deps.db, result.trajectoryId as string))).not.toContain(secret);
		expect(readFileSync(join(result.runDir as string, "scores", "round-0", "leaky.log"), "utf8")).not.toContain(secret);
		expect(readFileSync(join(result.runDir as string, "run.json"), "utf8")).not.toContain(secret);
	});

	it("records a command scorer timeout as SCORER_FAILED and kills the command", async () => {
		const env = judgeEnv({ config: { scoring: { scorers: [{ kind: "command", name: "slow-check", command: "sleep 30", timeoutMs: 200 }] } } });
		route(env, [fauxAssistantMessage("Done.")]);
		const started = Date.now();
		const result = await createEngine(env.deps).run({ instruction: "Do it" });
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(result.status).toBe("succeeded");
		expect(result.scores?.[0]).toMatchObject({ scorerName: "slow-check", status: "failed", error: { code: "SCORER_FAILED" } });
		expect(result.scores?.[0]?.error?.message).toContain("timed out after 200ms");
	});

	it("records an unreadable nexo-scorers file as a failed score instead of skipping scoring", async () => {
		const env = judgeEnv({ skills: { broken: '---\nname: broken\ndescription: x\nmetadata:\n  nexo-scorers: "missing.json"\n---\nbody\n' } });
		route(env, [fauxAssistantMessage("Done.")]);
		const result = await createEngine(env.deps).run({ instruction: "Do it", skill: "broken" });
		expect(result.status).toBe("succeeded");
		expect(result.scores).toEqual([expect.objectContaining({ scorerName: "nexo-scorers", status: "failed", error: expect.objectContaining({ code: "CONFIG_INVALID" }) })]);
	});

	it("fixes the scorers before the agent loop, so rewriting the scorer file during the run changes nothing", async () => {
		const env = judgeEnv({ skills: { fixed: skillMd("fixed", { "nexo-scorers": "scorers.json" }) } });
		const file = join(env.deps.paths.skills, "fixed", "scorers.json");
		writeFileSync(file, JSON.stringify([{ kind: "contains", name: "original", text: "ok" }]));
		route(env, [
			async () => {
				writeFileSync(file, JSON.stringify([{ kind: "command", name: "rewritten", command: "touch pwned.txt" }]));
				return fauxAssistantMessage("ok");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "Do it", skill: "fixed" });
		expect(result.scores?.map((s) => [s.scorerName, s.passed])).toEqual([["original", true]]);
		expect(existsSync(join(result.runDir as string, "workspace", "pwned.txt"))).toBe(false);
	});
});

describe("command scorer trust", () => {
	/** A working directory with a project config and, optionally, a project skill with a scorer file. */
	function project(config: unknown, skill?: { name: string; scorers: unknown }): string {
		const cwd = mkdtempSync(join(tmpdir(), "nexo-proj-"));
		mkdirSync(join(cwd, ".nexo"), { recursive: true });
		if (config) writeFileSync(join(cwd, ".nexo", "config.json"), JSON.stringify(config));
		if (skill) {
			const dir = join(cwd, ".nexo", "skills", skill.name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), skillMd(skill.name, { "nexo-scorers": "scorers.json" }));
			writeFileSync(join(dir, "scorers.json"), JSON.stringify(skill.scorers));
		}
		return cwd;
	}
	const touch = [{ kind: "command", name: "proj-check", command: "touch ran.txt" }];

	it("puts a command scorer from the project config through the bash policy and skips it when not approved", async () => {
		const env = judgeEnv({ cwd: project({ scoring: { scorers: touch } }) });
		route(env, [fauxAssistantMessage("Done.")]);
		const result = await createEngine(env.deps).run({ instruction: "Do it" });
		expect(result.status).toBe("succeeded");
		expect(result.scores?.[0]).toMatchObject({ scorerName: "proj-check", status: "failed", error: { code: "SCORER_FAILED" } });
		expect(result.scores?.[0]?.error?.message).toContain('was not run: Tool "bash" requires approval');
		expect(existsSync(join(result.runDir as string, "workspace", "ran.txt"))).toBe(false);
	});

	it("runs a project command scorer that the bash policy allows", async () => {
		const env = judgeEnv({ cwd: project({ scoring: { scorers: touch } }), config: { tools: { policy: { bash: "allow" } } } });
		route(env, [fauxAssistantMessage("Done.")]);
		const result = await createEngine(env.deps).run({ instruction: "Do it" });
		expect(result.scores?.[0]).toMatchObject({ scorerName: "proj-check", status: "ok", passed: true });
		expect(existsSync(join(result.runDir as string, "workspace", "ran.txt"))).toBe(true);
	});

	it("puts a command scorer from a project skill through the bash policy too", async () => {
		const env = judgeEnv({ cwd: project(null, { name: "proj-skill", scorers: touch }) });
		route(env, [fauxAssistantMessage("Done.")]);
		const result = await createEngine(env.deps).run({ instruction: "Do it", skill: "proj-skill" });
		expect(result.scores?.[0]).toMatchObject({ scorerName: "proj-check", status: "failed" });
		expect(result.scores?.[0]?.error?.message).toContain("requires approval");
	});

	it("runs user-level command scorers directly, without provider keys in their environment", async () => {
		const saved = { key: process.env.OPENAI_API_KEY, probe: process.env.NEXO_SCORER_PROBE };
		process.env.OPENAI_API_KEY = "test-scorer-env-value";
		process.env.NEXO_SCORER_PROBE = "kept";
		try {
			const command = 'echo "key=${OPENAI_API_KEY:-none} probe=$NEXO_SCORER_PROBE"';
			const env = judgeEnv({ config: { tools: { policy: { bash: "deny" } }, scoring: { scorers: [{ kind: "command", name: "env-check", command }] } } });
			route(env, [fauxAssistantMessage("Done.")]);
			const result = await createEngine(env.deps).run({ instruction: "Do it" });
			expect(result.scores?.[0]).toMatchObject({ scorerName: "env-check", status: "ok", passed: true });
			expect(result.scores?.[0]?.rationale).toContain("key=none probe=kept");
		} finally {
			for (const [name, value] of [["OPENAI_API_KEY", saved.key], ["NEXO_SCORER_PROBE", saved.probe]] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});

describe("scoring in session turns", () => {
	it("scores each turn and counts the judge cost toward the session", async () => {
		const env = judgeEnv({ config: JUDGE });
		route(env, [fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")], [verdict(0.8), verdict(0.9)]);
		const session = createSession(env.deps, { cwd: env.home });
		const one = await session.turn("first");
		const two = await session.turn("second");
		expect([one.scores?.[0]?.value, two.scores?.[0]?.value]).toEqual([0.8, 0.9]);
		const judgeCost = [one, two].flatMap((r) => listSpans(env.deps.db, r.trajectoryId as string)).filter((s) => s.kind === "judge_call").reduce((sum, s) => sum + s.costUsd, 0);
		expect(judgeCost).toBeGreaterThan(0);
		expect(session.costUsd).toBeCloseTo(one.costUsd + two.costUsd, 10);
		expect(session.transcript().filter((l) => l.type === "message")).toHaveLength(4);
		session.close();
	});
});
