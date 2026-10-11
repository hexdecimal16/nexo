import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getRun, getSessionRow, latestFeedback, listSpans, readRunJson, SessionDir } from "@nexo/store";
import { type NexoError, REDACTED } from "@nexo/telemetry";
import type { Prompter } from "@nexo/tools";
import { createSession, type EngineEvent, listSessions, resumeSession, type SessionDeps } from "../src/index.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** Non-system messages of a request, as `role:text` lines. */
function texts(ctx: TranscriptContext): string[] {
	return ctx.messages
		.filter((m) => m.role !== "system")
		.map((m) => {
			const content = typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join("");
			return `${m.role}:${content}`;
		});
}

function sessionEnv(options: Parameters<typeof makeEnv>[0] = {}): { env: TestEnv; deps: SessionDeps; cwd: string } {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "nexo-cwd-")));
	const env = makeEnv(options);
	return { env, deps: env.deps, cwd };
}

function expectCode(fn: () => unknown, code: string): NexoError {
	try {
		fn();
	} catch (error) {
		expect((error as NexoError).code).toBe(code);
		return error as NexoError;
	}
	throw new Error(`expected ${code}`);
}

describe("session turns", () => {
	it("carries the conversation into later turns and records every turn", async () => {
		const { env, deps, cwd } = sessionEnv();
		let second: string[] = [];
		env.faux.setResponses([
			fauxAssistantMessage("Hi, I am nexo."),
			async (ctx) => {
				second = texts(ctx);
				return fauxAssistantMessage("You said hello.");
			},
		]);
		const session = createSession(deps, { cwd });
		expect(session.workspace).toBe(cwd);
		const r1 = await session.turn("Hello there\nsecond line");
		const r2 = await session.turn("What did I say?");
		expect([r1.status, r2.status]).toEqual(["succeeded", "succeeded"]);
		expect(second[0]).toBe("user:Hello there\nsecond line");
		expect(second[1]).toBe("assistant:Hi, I am nexo.");
		expect(second[2]).toMatch(/^user:What did I say\?/);

		expect(session.turns).toBe(2);
		expect(session.title).toBe("Hello there");
		expect(session.costUsd).toBeCloseTo(r1.costUsd + r2.costUsd, 10);
		expect(session.lastRunId).toBe(r2.trajectoryId);
		expect(session.contextFraction).toBeGreaterThan(0);
		expect(session.contextFraction).toBeLessThan(1);
		expect(getRun(deps.db, r1.trajectoryId as string)).toMatchObject({ sessionId: session.id, turnIndex: 1 });
		expect(readRunJson(r2.runDir as string)).toMatchObject({ sessionId: session.id, turnIndex: 2, workspace: cwd });
		const row = getSessionRow(deps.db, session.id);
		expect(row).toMatchObject({ turns: 2, status: "active", title: "Hello there", cwd });
		expect(row?.costUsd).toBeCloseTo(session.costUsd, 10);
		const lines = new SessionDir(join(deps.paths.sessions, session.id), session.id, deps.redact).readTranscript();
		expect(lines.map((l) => `${l.type}:${l.turnIndex}`)).toEqual(["message:1", "message:1", "message:2", "message:2"]);
		expect(session.transcript()).toHaveLength(4);
	});

	it("streams each turn's engine events to that turn's onEvent and uses the caller's prompter", async () => {
		const asked: string[] = [];
		const prompter: Prompter = {
			interactive: true,
			confirm: async (question) => {
				asked.push(question);
				return true;
			},
		};
		const { env, deps, cwd } = sessionEnv({ prompter });
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })]), fauxAssistantMessage("ran it")]);
		const session = createSession(deps, { cwd });
		const events: EngineEvent[] = [];
		const result = await session.turn("run echo", { onEvent: (e) => events.push(e) });
		expect(result.status).toBe("succeeded");
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("echo hi");
		expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["run_start", "tool_start", "tool_end", "llm_end", "text_delta", "run_end"]));
		expect(events.find((e) => e.type === "tool_end")).toMatchObject({ toolName: "bash", isError: false });
	});

	it("refuses a turn once the session cap is spent and accepts it after setBudget", async () => {
		const { env, deps, cwd } = sessionEnv({ config: { budgets: { perSessionUsd: 0.002, perRunUsd: 0.5, estimateOutputTokens: 1 } } });
		let budgetLine = "";
		env.faux.setResponses([
			async (ctx) => {
				budgetLine = JSON.stringify(ctx.messages.at(-1));
				return fauxAssistantMessage("x".repeat(2000));
			},
			fauxAssistantMessage("after raise"),
		]);
		const session = createSession(deps, { cwd, model: "faux/pricey" });
		expect(session.budgetUsd).toBe(0.002);
		const first = await session.turn("spend it");
		expect(budgetLine).toContain("of $0.00 remaining");
		expect(first.costUsd).toBeGreaterThan(0.002);
		expect(session.remainingUsd).toBe(0);

		const refused = await session.turn("again");
		expect(refused).toMatchObject({ status: "budget_exceeded", trajectoryId: null, error: { code: "BUDGET_EXCEEDED" } });
		expect(refused.error?.message).toContain("$0.00");
		expect(refused.error?.hint).toContain("budgets.perSessionUsd");
		expect(refused.error?.hint).toContain("/budget");
		expect(session.turns).toBe(1);

		expectCode(() => session.setBudget(-1), "INVALID_REQUEST");
		session.setBudget(10);
		expect(getSessionRow(deps.db, session.id)?.budgetUsd).toBe(10);
		session.setModel("s1");
		const third = await session.turn("again");
		expect(third.status).toBe("succeeded");
		expect(session.turns).toBe(2);
	});

	it("caps each turn's run budget at the session's remaining budget", async () => {
		const { env, deps, cwd } = sessionEnv({ config: { budgets: { perSessionUsd: 0.2, perRunUsd: 0.5 } } });
		let line = "";
		env.faux.setResponses([
			async (ctx) => {
				line = JSON.stringify(ctx.messages.at(-1));
				return fauxAssistantMessage("ok");
			},
		]);
		await createSession(deps, { cwd }).turn("hi");
		expect(line).toMatch(/of \$0\.20 remaining/);
	});

	it("applies a reloaded config from the next turn", async () => {
		const { env, deps, cwd } = sessionEnv();
		const lines: string[] = [];
		const capture = async (ctx: TranscriptContext) => {
			lines.push(JSON.stringify(ctx.messages.at(-1)));
			return fauxAssistantMessage("ok");
		};
		env.faux.setResponses([capture, capture]);
		let config = deps.config;
		let configHash = deps.configHash;
		const session = createSession({ ...deps, reloadConfig: () => ({ config, configHash }) }, { cwd });
		await session.turn("one");
		config = { ...deps.config, budgets: { ...deps.config.budgets, perRunUsd: 0.25 } };
		configHash = "changed";
		await session.turn("two");
		expect(lines[0]).toMatch(/of \$0\.50 remaining/);
		expect(lines[1]).toMatch(/of \$0\.25 remaining/);
	});

	it("compacts older turns when the request would pass compactAt, keeping the last two turns verbatim", async () => {
		const { env, deps, cwd } = sessionEnv({ config: { session: { compactAt: 0.001 } } });
		let summaryInput = "";
		let fourth: string[] = [];
		env.faux.setResponses([
			fauxAssistantMessage("ANSWER-ONE"),
			fauxAssistantMessage("ANSWER-TWO"),
			fauxAssistantMessage("ANSWER-THREE"),
			async (ctx) => {
				summaryInput = JSON.stringify(ctx.messages);
				return fauxAssistantMessage("SUMMARY-OF-ONE");
			},
			async (ctx) => {
				fourth = texts(ctx);
				return fauxAssistantMessage("ANSWER-FOUR");
			},
		]);
		const session = createSession(deps, { cwd });
		const events: EngineEvent[] = [];
		await session.turn("QUESTION-ONE");
		await session.turn("QUESTION-TWO");
		await session.turn("QUESTION-THREE");
		const r4 = await session.turn("QUESTION-FOUR", { onEvent: (e) => events.push(e) });
		expect(r4.status).toBe("succeeded");
		expect(summaryInput).toContain("QUESTION-ONE");
		expect(summaryInput).toContain("ANSWER-ONE");
		expect(summaryInput).not.toContain("QUESTION-THREE");
		const joined = fourth.join("\n");
		expect(fourth[0]).toContain("SUMMARY-OF-ONE");
		expect(joined).not.toContain("QUESTION-ONE");
		expect(joined).toContain("QUESTION-TWO");
		expect(joined).toContain("ANSWER-THREE");

		const spans = listSpans(deps.db, r4.trajectoryId as string);
		const compaction = spans.find((s) => s.kind === "compaction");
		expect(compaction?.costUsd).toBeGreaterThan(0);
		const llm = spans.filter((s) => s.kind === "llm_call").reduce((sum, s) => sum + s.costUsd, 0);
		expect(r4.costUsd).toBeCloseTo(llm + (compaction?.costUsd ?? 0), 10);
		expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["compaction_start", "compaction_end"]));
		const marker = session.transcript().find((l) => l.type === "compaction");
		expect(marker).toEqual({ type: "compaction", turnIndex: 4, summary: "SUMMARY-OF-ONE", replacedThroughTurn: 1 });
		expect(session.transcript().filter((l) => l.type === "message")).toHaveLength(8);
	});

	it("compacts on request before the next turn, and clear starts a fresh conversation", async () => {
		const { env, deps, cwd } = sessionEnv();
		let fourth: string[] = [];
		let fifth: string[] = [];
		env.faux.setResponses([
			fauxAssistantMessage("A1"),
			fauxAssistantMessage("A2"),
			fauxAssistantMessage("A3"),
			fauxAssistantMessage("SUMMARY"),
			async (ctx) => {
				fourth = texts(ctx);
				return fauxAssistantMessage("A4");
			},
			async (ctx) => {
				fifth = texts(ctx);
				return fauxAssistantMessage("A5");
			},
		]);
		const session = createSession(deps, { cwd });
		await session.turn("Q1");
		await session.turn("Q2");
		await session.turn("Q3");
		session.compact();
		expect(session.compactPending).toBe(true);
		await session.turn("Q4");
		expect(session.compactPending).toBe(false);
		expect(fourth[0]).toContain("SUMMARY");
		expect(fourth.join("\n")).not.toContain("Q1");
		session.clear();
		await session.turn("Q5");
		expect(fifth).toHaveLength(1);
		expect(fifth[0]).toMatch(/^user:Q5/);
		expect(session.transcript().at(-3)).toEqual({ type: "compaction", turnIndex: 4, summary: "", replacedThroughTurn: 4 });
	});

	it("records the partial messages of an aborted turn so the next turn sees them", async () => {
		const { env, deps, cwd } = sessionEnv();
		const ac = new AbortController();
		let next: string[] = [];
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })]),
			async () => {
				ac.abort();
				return fauxAssistantMessage("never");
			},
			async (ctx) => {
				next = texts(ctx);
				return fauxAssistantMessage("continuing");
			},
		]);
		const session = createSession(deps, { cwd });
		const aborted = await session.turn("read the file", { signal: ac.signal });
		expect(aborted.status).toBe("aborted");
		expect(session.turns).toBe(1);
		const roles = session.transcript().map((l) => (l.type === "message" ? (l.message as { role: string }).role : l.type));
		expect(roles.slice(0, 3)).toEqual(["user", "assistant", "toolResult"]);
		await session.turn("go on");
		expect(next[0]).toBe("user:read the file");
		expect(next.some((t) => t.startsWith("toolResult:"))).toBe(true);
	});

	it("rejects empty instructions and overlapping turns", async () => {
		const { env, deps, cwd } = sessionEnv();
		let release: () => void = () => {};
		env.faux.setResponses([
			() => new Promise((resolve) => {
				release = () => resolve(fauxAssistantMessage("slow"));
			}),
		]);
		const session = createSession(deps, { cwd });
		await expect(session.turn("   ")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		const pending = session.turn("first");
		expect(session.running).toBe(true);
		await expect(session.turn("second")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await new Promise((r) => setTimeout(r, 10));
		release();
		await pending;
		expect(session.running).toBe(false);
	});
});

describe("session state", () => {
	it("resumes a closed session with its history, cost and overrides; secrets read back redacted", async () => {
		const { env, deps, cwd } = sessionEnv();
		let resumed: string[] = [];
		env.faux.setResponses([
			fauxAssistantMessage("noted"),
			async (ctx) => {
				resumed = texts(ctx);
				return fauxAssistantMessage("back");
			},
		]);
		const session = createSession(deps, { cwd });
		session.setEffort("low");
		await session.turn("my key is sk-ant-abcdefghijklmnopqrstuvwxyz0123");
		const cost = session.costUsd;
		session.close();
		expect(session.status).toBe("closed");
		expect(getSessionRow(deps.db, session.id)?.status).toBe("closed");
		const raw = readFileSync(join(deps.paths.sessions, session.id, "transcript.jsonl"), "utf8");
		expect(raw).not.toContain("sk-ant-abcdef");
		expect(raw).toContain(REDACTED);
		expect(session.title).not.toContain("sk-ant-abcdef");

		const again = resumeSession(deps, session.id);
		expect(again.status).toBe("active");
		expect(getSessionRow(deps.db, session.id)?.status).toBe("active");
		expect(again.turns).toBe(1);
		expect(again.costUsd).toBeCloseTo(cost, 10);
		expect(again.effort).toBe("low");
		const r = await again.turn("continue");
		expect(r.status).toBe("succeeded");
		expect(resumed[0]).toBe(`user:my key is ${REDACTED}`);
		expect(resumed[1]).toBe("assistant:noted");
		expect(again.turns).toBe(2);
		expect(getRun(deps.db, r.trajectoryId as string)?.turnIndex).toBe(2);
	});

	it("resume of an unknown session is NOT_FOUND", () => {
		const { deps } = sessionEnv();
		expectCode(() => resumeSession(deps, "01NOPE"), "NOT_FOUND");
		expectCode(() => resumeSession(deps, "../escape"), "NOT_FOUND");
	});

	it("reviews the latest turn through recordFeedback", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const session = createSession(deps, { cwd });
		expectCode(() => session.review("done"), "INVALID_REQUEST");
		await session.turn("first");
		const r2 = await session.turn("second");
		const row = session.review("not_done", "missed a step");
		expect(row).toMatchObject({ runId: r2.trajectoryId, verdict: "not_done", comment: "missed a step" });
		expect(latestFeedback(deps.db, r2.trajectoryId as string)?.verdict).toBe("not_done");
		expect(readRunJson(r2.runDir as string).humanVerdict?.verdict).toBe("not_done");
	});

	it("validates and applies model and effort overrides", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("ok")]);
		const session = createSession(deps, { cwd });
		expectCode(() => session.setModel("nonsense"), "INVALID_REQUEST");
		expectCode(() => session.setModel("faux/unknown-model"), "INVALID_REQUEST");
		expectCode(() => session.setEffort("extreme" as never), "INVALID_REQUEST");
		session.setModel("s2");
		session.setEffort("high");
		expect(JSON.parse(readFileSync(join(deps.paths.sessions, session.id, "session.json"), "utf8"))).toMatchObject({ model: "s2", effort: "high" });
		const r = await session.turn("hi");
		expect(readRunJson(r.runDir as string).model).toMatchObject({ id: "slow", source: "user" });
		expect(session.lastModel).toMatchObject({ provider: "faux", id: "slow" });
		session.setModel(null);
		expect(session.model).toBeNull();
	});

	it("works in the given workspace and rejects a missing one", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "note.txt", content: "hi" })]), fauxAssistantMessage("wrote")]);
		const session = createSession(deps, { cwd });
		await session.turn("write a note");
		expect(readFileSync(join(cwd, "note.txt"), "utf8")).toBe("hi");
		expectCode(() => createSession(deps, { cwd, workspace: join(cwd, "missing") }), "CONFIG_INVALID");
	});

	it("lists sessions most recently updated first", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("ok")]);
		const a = createSession(deps, { cwd });
		const b = createSession(deps, { cwd });
		await a.turn("latest");
		expect(listSessions(deps.db).map((s) => s.id)).toEqual([a.id, b.id]);
		expect(listSessions(deps.db, { limit: 1 })).toHaveLength(1);
		expect(existsSync(join(deps.paths.sessions, b.id, "session.json"))).toBe(true);
		expect(() => listSessions(deps.db, { limit: 0 })).toThrow();
	});
});
