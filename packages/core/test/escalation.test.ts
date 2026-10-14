import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getRun, listScores, listSpans, readRunJson } from "@nexo/store";
import { createEngine, createSession, type DeepPartial, type EngineEvent, type NexoConfig } from "../src/index.ts";
import { firstUserText } from "./helpers.ts";
import { JUDGE, judgeEnv, judges, route, skillMd, verdict } from "./scoring-helpers.ts";

describe("end-of-run escalation", () => {
	it("fails a run with CONFIG_INVALID when the active router policy is invalid", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nexo-pol-"));
		writeFileSync(join(dir, "p.json"), "{ nope");
		const env = judgeEnv({ config: { router: { policy: `file:${join(dir, "p.json")}` } } });
		env.faux.setResponses([fauxAssistantMessage("never")]);
		const result = await createEngine(env.deps).run({ instruction: "x" });
		expect(result).toMatchObject({ status: "failed", error: { code: "CONFIG_INVALID" } });
		expect(result.error?.message).toContain("is not valid JSON");
	});

	const contains: DeepPartial<NexoConfig> = { scoring: { scorers: [{ kind: "contains", name: "says-done", text: "DONE" }] } };

	it("continues on S2 with the failure feedback when a deterministic scorer fails (verify_fail)", async () => {
		const env = judgeEnv({ config: contains });
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		let continuation = "";
		route(env, [
			fauxAssistantMessage("not yet"),
			async (context) => {
				const last = [...context.messages].reverse().find((m) => m.role === "user");
				continuation = typeof last?.content === "string" ? last.content : (last?.content.map((b) => ("text" in b ? b.text : "")).join("") ?? "");
				return fauxAssistantMessage("DONE now");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "Finish the job" });

		expect(result).toMatchObject({ status: "succeeded", output: "DONE now", escalations: 1, model: { id: "slow" } });
		expect(continuation).toContain("verify_fail: deterministic scorer failed: says-done");
		expect(continuation).toContain('says-done [contains] (score 0.00)');
		const runId = result.trajectoryId as string;
		const spans = listSpans(env.deps.db, runId);
		expect(spans.filter((s) => s.kind === "llm_call").map((s) => [s.model, s.tier, s.modelSource])).toEqual([
			["fast", "s1", "default"],
			["slow", "s2", "router"],
		]);
		expect(spans.find((s) => s.kind === "escalation")?.attrs).toMatchObject({ trigger: "verify_fail", phase: "end_of_run", applied: true, from: "faux/fast", to: "faux/slow" });
		expect(listScores(env.deps.db, runId).map((s) => [s.round, s.passed])).toEqual([
			[0, false],
			[1, true],
		]);
		expect(result.scores).toEqual([expect.objectContaining({ round: 1, passed: true })]);
		expect(getRun(env.deps.db, runId)).toMatchObject({ escalations: 1, tierFinal: "s2", modelFinal: "faux/slow" });
		expect(readRunJson(result.runDir as string)).toMatchObject({ escalations: 1, model: { id: "slow", source: "router", role: "s2" } });
		expect(existsSync(join(result.runDir as string, "artifacts", "router_policy.json"))).toBe(true);
		expect(events.find((e) => e.type === "escalation")).toMatchObject({ trigger: "verify_fail", applied: true, model: "faux/slow" });
	});

	it("continues on S2 when the judge score is low (judge_low)", async () => {
		const env = judgeEnv({ config: JUDGE });
		route(env, [fauxAssistantMessage("meh"), fauxAssistantMessage("better")], [verdict(0.3, "missing parts"), verdict(0.9)]);
		const result = await createEngine(env.deps).run({ instruction: "Write it" });
		expect(result).toMatchObject({ output: "better", escalations: 1 });
		const escalation = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "escalation");
		expect(escalation?.attrs).toMatchObject({ trigger: "judge_low", applied: true });
		expect(String(escalation?.attrs.reason)).toContain("judge score 0.30 is below 0.6");
	});

	it("stops after router.maxEscalations and records the suppressed trigger once", async () => {
		const env = judgeEnv({ config: { ...contains, router: { maxEscalations: 0 } } });
		route(env, [fauxAssistantMessage("not yet")]);
		const result = await createEngine(env.deps).run({ instruction: "Finish" });
		expect(result).toMatchObject({ status: "succeeded", output: "not yet", escalations: 0, model: { id: "fast" } });
		const escalations = listSpans(env.deps.db, result.trajectoryId as string).filter((s) => s.kind === "escalation");
		expect(escalations.map((s) => s.attrs)).toEqual([expect.objectContaining({ trigger: "verify_fail", applied: false, blockedBy: "max_escalations" })]);
	});

	it("suppresses escalation once the run spent more than budgets.escalationCutoff of its budget", async () => {
		const env = judgeEnv({ config: { ...contains, budgets: { estimateOutputTokens: 1 }, pricingOverrides: { "faux/fast": { input: 0, output: 9000 } } } });
		route(env, [fauxAssistantMessage("x".repeat(400))]);
		const result = await createEngine(env.deps).run({ instruction: "Finish", budgetUsd: 1 });
		expect(result.costUsd).toBeCloseTo(0.9);
		expect(result).toMatchObject({ status: "succeeded", escalations: 0 });
		const span = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "escalation");
		expect(span?.attrs).toMatchObject({ applied: false, blockedBy: "budget_cutoff" });
	});

	it("never escalates inside a skill with nexo-escalate: false", async () => {
		const env = judgeEnv({ config: contains, skills: { pinned: skillMd("pinned", { "nexo-escalate": "false" }) } });
		route(env, [fauxAssistantMessage("not yet")]);
		const result = await createEngine(env.deps).run({ instruction: "Finish", skill: "pinned" });
		expect(result.escalations).toBe(0);
		expect(listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "escalation")?.attrs).toMatchObject({ applied: false, blockedBy: "skill_disabled" });
	});

	it("records an escalation that the skill's nexo-model-allowed forbids as suppressed (model not allowed)", async () => {
		const env = judgeEnv({ config: contains, skills: { cheap: skillMd("cheap", { "nexo-model-allowed": "s1" }) } });
		route(env, [fauxAssistantMessage("not yet")]);
		const result = await createEngine(env.deps).run({ instruction: "Finish", skill: "cheap" });
		expect(result).toMatchObject({ status: "succeeded", output: "not yet", escalations: 0, model: { id: "fast" } });
		expect(listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "escalation")?.attrs).toMatchObject({
			trigger: "verify_fail",
			applied: false,
			blockedBy: "model_not_allowed",
			blockedReason: "model not allowed",
		});
	});

	it("keeps the model the user chose explicitly", async () => {
		const env = judgeEnv({ config: contains });
		route(env, [fauxAssistantMessage("not yet")]);
		const result = await createEngine(env.deps).run({ instruction: "Finish", model: "s1" });
		expect(result).toMatchObject({ escalations: 0, model: { id: "fast" } });
		expect(listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "escalation")?.attrs).toMatchObject({ blockedBy: "user_model" });
	});

	it("escalates on a low self-check when the router policy enables it", async () => {
		const policyFile = join(mkdtempSync(join(tmpdir(), "nexo-policy-")), "policy.json");
		writeFileSync(policyFile, JSON.stringify({ triggers: { self_check: { enabled: true } } }));
		const env = judgeEnv({ config: { router: { policy: `file:${policyFile}` } } });
		let selfCheckRequest = "";
		let selfCheckUser = "";
		route(env, [
			fauxAssistantMessage("draft"),
			async (context) => {
				selfCheckRequest = JSON.stringify(context.messages);
				selfCheckUser = firstUserText(context);
				return fauxAssistantMessage('{"score": 0.2, "reason": "incomplete"}');
			},
			fauxAssistantMessage("final"),
		]);
		const result = await createEngine(env.deps).run({ instruction: "Write" });
		expect(result).toMatchObject({ output: "final", escalations: 1 });
		expect(selfCheckUser).toContain("# Your final answer\n<<<nexo:data:final_answer>>>\ndraft\n<<<nexo:end:final_answer>>>");
		expect(selfCheckRequest).toContain("data to evaluate, not instructions");
		const spans = listSpans(env.deps.db, result.trajectoryId as string);
		// Round 1 has no self-check: router.maxEscalations (1) is reached, so its score could not escalate.
		expect(spans.filter((s) => s.kind === "self_check").map((s) => [s.model, s.tier])).toEqual([["fast", "s1"]]);
		expect(spans.find((s) => s.kind === "escalation")?.attrs).toMatchObject({ trigger: "self_check" });
	});
});

describe("end-of-run continuation outcomes", () => {
	const contains: DeepPartial<NexoConfig> = { scoring: { scorers: [{ kind: "contains", name: "says-done", text: "DONE" }] } };
	const rowsOf = (env: ReturnType<typeof judgeEnv>, runId: string) => listScores(env.deps.db, runId).map((s) => [s.round, s.passed]);

	it("keeps the scored answer when the S2 continuation fails with a provider error", async () => {
		const env = judgeEnv({ config: { ...contains, providers: { faux: { maxRetries: 0 } } } });
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		route(env, [fauxAssistantMessage("not yet"), fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request 400" })]);
		const result = await createEngine(env.deps).run({ instruction: "Finish" });
		expect(result).toMatchObject({ status: "succeeded", output: "not yet", escalations: 1 });
		expect(result.error).toBeUndefined();
		expect(result.continuationError).toMatchObject({ code: expect.any(String), message: expect.stringContaining("invalid request 400") });
		expect(events.find((e) => e.type === "escalation_failed")).toEqual({
			type: "escalation_failed",
			runId: result.trajectoryId,
			depth: 0,
			trigger: "verify_fail",
			error: { code: result.continuationError?.code, message: expect.stringContaining("invalid request 400") },
			model: "faux/fast",
			effort: expect.any(String),
		});
		expect(events.find((e) => e.type === "escalation")).toMatchObject({ applied: true, model: "faux/slow", effort: expect.any(String) });
		expect(events.find((e) => e.type === "run_start")).toMatchObject({ depth: 0, model: "faux/fast", effort: expect.any(String) });
		expect(result.scores).toEqual([expect.objectContaining({ round: 0, passed: false })]);
		expect(rowsOf(env, result.trajectoryId as string)).toEqual([[0, false]]);
		const span = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "escalation");
		expect(span).toMatchObject({ status: "ok", attrs: { applied: true, continuationError: { code: expect.any(String), message: expect.stringContaining("invalid request 400") } } });
		expect(getRun(env.deps.db, result.trajectoryId as string)).toMatchObject({ status: "succeeded", escalations: 1, modelFinal: "faux/fast", tierFinal: "s1" });
		expect(readRunJson(result.runDir as string)).toMatchObject({ escalations: 1, model: { id: "fast", role: "s1" } });
		expect(result.model).toMatchObject({ provider: "faux", id: "fast" });
	});

	it("suppresses an escalation the remaining budget cannot afford two S2 requests of", async () => {
		const env = judgeEnv({ config: { ...contains, pricingOverrides: { "faux/slow": { input: 1_000_000_000, output: 1_000_000_000 } } } });
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		route(env, [fauxAssistantMessage("not yet"), fauxAssistantMessage("never sent")]);
		const result = await createEngine(env.deps).run({ instruction: "Finish", budgetUsd: 1 });
		expect(result).toMatchObject({ status: "succeeded", output: "not yet", escalations: 0 });
		expect(result.continuationError).toBeUndefined();
		expect(events.find((e) => e.type === "escalation")).toMatchObject({ applied: false, blockedBy: "budget_headroom", model: "faux/fast" });
		const span = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "escalation");
		expect(span?.attrs).toMatchObject({ applied: false, blockedBy: "budget_headroom", blockedReason: expect.stringContaining("2 S2 requests") });
	});

	it("keeps the scored answer when the S2 continuation spends past the run budget", async () => {
		// The pre-call estimate (one output token) passes the headroom check; the actual reply costs more than the budget.
		const env = judgeEnv({
			config: { ...contains, budgets: { estimateOutputTokens: 1 }, pricingOverrides: { "faux/slow": { input: 0, output: 100_000 } } },
		});
		route(env, [
			fauxAssistantMessage("not yet"),
			fauxAssistantMessage([fauxText("working ".repeat(40)), fauxToolCall("write", { path: "a.txt", content: "x" })]),
			fauxAssistantMessage("never sent"),
		]);
		const result = await createEngine(env.deps).run({ instruction: "Finish", budgetUsd: 1 });
		expect(result).toMatchObject({ status: "succeeded", output: "not yet", escalations: 1 });
		expect(result.error).toBeUndefined();
		const span = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "escalation");
		expect(span?.attrs).toMatchObject({ applied: true, continuationError: { code: "BUDGET_EXCEEDED" } });
		expect(result.continuationError).toMatchObject({ code: "BUDGET_EXCEEDED" });
	});

	it("ends the run aborted when it is aborted during the continuation", async () => {
		const env = judgeEnv({ config: contains });
		const controller = new AbortController();
		route(env, [
			fauxAssistantMessage("not yet"),
			async () => {
				controller.abort();
				return fauxAssistantMessage("DONE");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "Finish" }, controller.signal);
		expect(result.status).toBe("aborted");
		expect(listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "escalation")?.status).toBe("ok");
	});

	it("skips the self-check when an escalation could not happen anyway", async () => {
		const policyFile = join(mkdtempSync(join(tmpdir(), "nexo-policy-")), "policy.json");
		writeFileSync(policyFile, JSON.stringify({ triggers: { self_check: { enabled: true } } }));
		const env = judgeEnv({ config: { router: { policy: `file:${policyFile}`, maxEscalations: 0 } } });
		const script = route(env, [fauxAssistantMessage("draft")]);
		const result = await createEngine(env.deps).run({ instruction: "Write" });
		expect(result).toMatchObject({ status: "succeeded", output: "draft", escalations: 0 });
		expect(script.agentCalls()).toBe(1);
		expect(listSpans(env.deps.db, result.trajectoryId as string).filter((s) => s.kind === "self_check")).toEqual([]);
	});

	it("passes the escalation event reason through the redactor", async () => {
		const env = judgeEnv({ config: contains });
		const base = env.deps.redact;
		// Marks every reason string the redactor sees, so the test shows the event reason went through it.
		env.deps.redact = (<T,>(value: T): T => (typeof value === "string" ? (base(value).replace("scorer failed", "scorer [checked]") as T) : base(value))) as typeof base;
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		route(env, [fauxAssistantMessage("not yet"), fauxAssistantMessage("DONE")]);
		await createEngine(env.deps).run({ instruction: "Finish" });
		const event = events.find((e) => e.type === "escalation");
		expect(event?.type === "escalation" ? event.reason : "").toBe("deterministic scorer [checked]: says-done");
	});
});

describe("mid-run escalation", () => {
	it("switches the next request to S2 after consecutive tool failures", async () => {
		const env = judgeEnv();
		route(env, [
			fauxAssistantMessage([fauxToolCall("read", { path: "missing-1.txt" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "missing-2.txt" })]),
			fauxAssistantMessage("gave up"),
		]);
		const result = await createEngine(env.deps).run({ instruction: "Read files" });
		const spans = listSpans(env.deps.db, result.trajectoryId as string);
		expect(spans.filter((s) => s.kind === "llm_call").map((s) => s.model)).toEqual(["fast", "fast", "slow"]);
		expect(spans.find((s) => s.kind === "escalation")?.attrs).toMatchObject({ trigger: "tool_failures", phase: "mid_run", applied: true });
		expect(result.escalations).toBe(1);
	});

	it("suppresses a mid-run escalation once the run spent more than budgets.escalationCutoff", async () => {
		const env = judgeEnv({ config: { budgets: { estimateOutputTokens: 1 }, pricingOverrides: { "faux/fast": { input: 0, output: 9000 } } } });
		route(env, [
			fauxAssistantMessage([fauxText("x".repeat(300)), fauxToolCall("read", { path: "missing-1.txt" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "missing-2.txt" })]),
			fauxAssistantMessage("gave up"),
		]);
		const result = await createEngine(env.deps).run({ instruction: "Read files", budgetUsd: 1 });
		const spans = listSpans(env.deps.db, result.trajectoryId as string);
		// The two failing turns cost more than $0.80 of the $1 budget before the second failure fires the trigger.
		expect(spans.filter((s) => s.kind === "llm_call").slice(0, 2).reduce((sum, s) => sum + s.costUsd, 0)).toBeGreaterThan(0.8);
		expect(spans.filter((s) => s.kind === "llm_call").map((s) => s.model)).toEqual(["fast", "fast", "fast"]);
		expect(spans.find((s) => s.kind === "escalation")?.attrs).toMatchObject({ trigger: "tool_failures", phase: "mid_run", applied: false, blockedBy: "budget_cutoff" });
		expect(result).toMatchObject({ status: "succeeded", escalations: 0 });
	});

	it("checks the judge's family against every model that generated the run, S1 and S2", async () => {
		const env = judgeEnv({ config: judges("free") });
		route(env, [
			fauxAssistantMessage([fauxToolCall("read", { path: "missing-1.txt" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "missing-2.txt" })]),
			fauxAssistantMessage("gave up"),
			fauxAssistantMessage(verdict(0.9)),
		]);
		const result = await createEngine(env.deps).run({ instruction: "Read files" });
		expect(result.escalations).toBe(1);
		expect(result.scores?.[0]?.details.sameFamily).toEqual([
			{ judge: "faux/free", generator: "faux/fast", family: "faux" },
			{ judge: "faux/free", generator: "faux/slow", family: "faux" },
		]);
	});

	it("escalates after turns that repeat the same tool results (stagnation)", async () => {
		const env = judgeEnv({ config: { tools: { policy: { bash: "allow" } } } });
		const same = () => fauxAssistantMessage([fauxToolCall("bash", { command: "echo same" })]);
		route(env, [same(), same(), same(), same(), fauxAssistantMessage("stuck")]);
		const result = await createEngine(env.deps).run({ instruction: "Loop" });
		const models = listSpans(env.deps.db, result.trajectoryId as string).filter((s) => s.kind === "llm_call").map((s) => s.model);
		expect(models).toEqual(["fast", "fast", "fast", "fast", "slow"]);
		expect(listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "escalation")?.attrs).toMatchObject({ trigger: "stagnation" });
	});

	it("escalates when load_skill brings in a skill that sets nexo-model: s2 (skill_hint)", async () => {
		const env = judgeEnv({ skills: { hard: '---\nname: hard\ndescription: hard task\nmetadata:\n  nexo-model: "s2"\n---\nThink hard.\n' } });
		route(env, [fauxAssistantMessage([fauxToolCall("load_skill", { name: "hard" })]), fauxAssistantMessage("solved")]);
		const result = await createEngine(env.deps).run({ instruction: "Solve" });
		const spans = listSpans(env.deps.db, result.trajectoryId as string);
		expect(spans.filter((s) => s.kind === "llm_call").map((s) => s.model)).toEqual(["fast", "slow"]);
		expect(spans.find((s) => s.kind === "escalation")?.attrs).toMatchObject({ trigger: "skill_hint", reason: 'skill "hard" sets nexo-model: s2' });
	});
});

describe("escalation in subagents", () => {
	it("escalates each run on its own, and nexo-escalate: false on the child's skill blocks only the child", async () => {
		const env = judgeEnv({ skills: { pinned: skillMd("pinned", { "nexo-escalate": "false" }) } });
		route(env, [
			fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "a", instruction: "child task", skill: "pinned" }] })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "missing-1.txt" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "missing-2.txt" })]),
			fauxAssistantMessage("child gave up"),
			fauxAssistantMessage([fauxToolCall("read", { path: "missing-3.txt" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "missing-4.txt" })]),
			fauxAssistantMessage("parent done"),
		]);
		const result = await createEngine(env.deps).run({ instruction: "Fan out" });
		expect(result).toMatchObject({ status: "succeeded", output: "parent done", escalations: 1, model: { id: "slow" } });
		const parentSpans = listSpans(env.deps.db, result.trajectoryId as string);
		const childId = parentSpans.find((s) => s.kind === "subagent")?.attrs.trajectoryId as string;
		const childSpans = listSpans(env.deps.db, childId);
		expect(childSpans.filter((s) => s.kind === "llm_call").map((s) => s.model)).toEqual(["fast", "fast", "fast"]);
		expect(childSpans.filter((s) => s.kind === "escalation").map((s) => s.attrs)).toEqual([
			expect.objectContaining({ trigger: "tool_failures", applied: false, blockedBy: "skill_disabled" }),
		]);
		expect(getRun(env.deps.db, childId)).toMatchObject({ escalations: 0, tierFinal: "s1" });
		expect(parentSpans.filter((s) => s.kind === "llm_call").map((s) => s.model)).toEqual(["fast", "fast", "fast", "slow"]);
		expect(parentSpans.filter((s) => s.kind === "escalation").map((s) => s.attrs)).toEqual([
			expect.objectContaining({ trigger: "tool_failures", applied: true, phase: "mid_run" }),
		]);
	});
});

describe("escalation in session turns", () => {
	it("keeps the continuation feedback in the session transcript", async () => {
		const env = judgeEnv({ config: { scoring: { scorers: [{ kind: "contains", name: "says-done", text: "DONE" }] } } });
		route(env, [fauxAssistantMessage("not yet"), fauxAssistantMessage("DONE")]);
		const session = createSession(env.deps, { cwd: env.home });
		const one = await session.turn("first");
		expect(one.escalations).toBe(1);
		const userTexts = session
			.transcript()
			.flatMap((l) => (l.type === "message" ? [l.message as Message] : []))
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join("")));
		expect(userTexts).toEqual(["first", expect.stringContaining("[nexo] Your previous answer did not pass the end-of-run checks")]);
		expect(userTexts[1]).toContain("verify_fail: deterministic scorer failed: says-done");
		session.close();
	});

	it("escalates within one turn and starts the next turn on S1 again", async () => {
		const env = judgeEnv({ config: { scoring: { scorers: [{ kind: "contains", name: "says-done", text: "DONE" }] } } });
		route(env, [fauxAssistantMessage("not yet"), fauxAssistantMessage("DONE"), fauxAssistantMessage("DONE again")]);
		const session = createSession(env.deps, { cwd: env.home });
		const one = await session.turn("first");
		expect(one).toMatchObject({ escalations: 1, model: { id: "slow" } });
		const two = await session.turn("second");
		expect(two).toMatchObject({ escalations: 0, model: { id: "fast" } });
		expect(session.costUsd).toBeCloseTo(one.costUsd + two.costUsd, 10);
		session.close();
	});
});
