import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { getRun, getSessionRow, insertRun, latestFeedback, listSpans, readRunJson, SessionDir } from "@nexo/store";
import { type NexoError, REDACTED } from "@nexo/telemetry";
import type { Prompter } from "@nexo/tools";
import { createSession, type EngineEvent, listSessions, resumeSession, type SessionDeps } from "../src/index.ts";
import { runRow } from "../../store/test/fixtures.ts";
import { renderForSummary } from "../src/session/transcript.ts";
import { lastToolResultText, makeEnv, type TestEnv } from "./helpers.ts";

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
		expect(session.workspace).toBeNull();
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
		expect(readRunJson(r2.runDir as string)).toMatchObject({ sessionId: session.id, turnIndex: 2, workspace: join(r2.runDir as string, "workspace") });
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
			approve: async (request) => {
				asked.push(request.question);
				return "once";
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
		const { env, deps, cwd } = sessionEnv({ config: { budgets: { perSessionUsd: 0.002, perRunUsd: 0.5, perTurnShare: 1, estimateOutputTokens: 1 } } });
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
		const { env, deps, cwd } = sessionEnv({ config: { budgets: { perSessionUsd: 0.2, perRunUsd: 0.5, perTurnShare: 1 } } });
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

	it("names the session's remaining budget and /budget when it is what stopped the turn", async () => {
		const { env, deps, cwd } = sessionEnv({ config: { budgets: { perSessionUsd: 0.2, perRunUsd: 0.5, perTurnShare: 1 } } });
		env.faux.setResponses([fauxAssistantMessage("never sent")]);
		const result = await createSession(deps, { cwd, model: "faux/pricey" }).turn("expensive");
		expect(result.status).toBe("budget_exceeded");
		expect(result.error?.message).toBe("Turn budget of $0.20 is not enough to continue ($0.0000 spent; capped by the session's remaining budget)");
		expect(result.error?.hint).toContain("/budget <usd>");
		expect(result.error?.hint).not.toContain("--budget");
	});

	it("caps a turn at what is left of the daily budget", async () => {
		const { env, deps, cwd } = sessionEnv({ config: { budgets: { perSessionUsd: 5, perRunUsd: 0.5, dailyUsd: 0.3 } } });
		let line = "";
		env.faux.setResponses([
			async (ctx) => {
				line = JSON.stringify(ctx.messages.at(-1));
				return fauxAssistantMessage("ok");
			},
		]);
		await createSession(deps, { cwd }).turn("hi");
		expect(line).toMatch(/of \$0\.30 remaining/);
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
		config = { ...deps.config, budgets: { ...deps.config.budgets, perSessionUsd: 2.5 } };
		configHash = "changed";
		await session.turn("two");
		expect(lines[0]).toMatch(/of \$1\.00 remaining/);
		expect(lines[1]).toMatch(/of \$0\.50 remaining/);
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

	it("compacts when one S2 request with the history would cost more than compactAtBudgetShare of the turn budget", async () => {
		// compactAt is out of reach; S2 (faux/slow) input costs $5 per million tokens, and each answer adds about 5k tokens.
		const { env, deps, cwd } = sessionEnv({
			config: { session: { compactAt: 1, compactAtBudgetShare: 0.05 }, budgets: { perRunUsd: 1, perSessionUsd: 10, perTurnShare: 0.1, estimateOutputTokens: 1 } },
		});
		const long = (label: string) => fauxAssistantMessage(`${label} ${"word ".repeat(4000)}`);
		let summarized = false;
		env.faux.setResponses([
			long("ANSWER-ONE"),
			long("ANSWER-TWO"),
			long("ANSWER-THREE"),
			async () => {
				summarized = true;
				return fauxAssistantMessage("SUMMARY-OF-ONE");
			},
			fauxAssistantMessage("ANSWER-FOUR"),
		]);
		const session = createSession(deps, { cwd });
		await session.turn("QUESTION-ONE");
		await session.turn("QUESTION-TWO");
		await session.turn("QUESTION-THREE");
		expect(session.transcript().some((l) => l.type === "compaction")).toBe(false);
		await session.turn("QUESTION-FOUR");
		expect(summarized).toBe(true);
		expect(session.transcript().find((l) => l.type === "compaction")).toMatchObject({ turnIndex: 4, summary: "SUMMARY-OF-ONE", replacedThroughTurn: 1 });
	});

	it("does not compact on cost when compactAtBudgetShare is 0", async () => {
		const { env, deps, cwd } = sessionEnv({
			config: { session: { compactAt: 1, compactAtBudgetShare: 0 }, budgets: { perRunUsd: 1, perSessionUsd: 10, perTurnShare: 0.1, estimateOutputTokens: 1 } },
		});
		const long = (label: string) => fauxAssistantMessage(`${label} ${"word ".repeat(4000)}`);
		env.faux.setResponses([long("A1"), long("A2"), long("A3"), fauxAssistantMessage("A4")]);
		const session = createSession(deps, { cwd });
		for (const q of ["Q1", "Q2", "Q3", "Q4"]) await session.turn(q);
		expect(session.transcript().some((l) => l.type === "compaction")).toBe(false);
		expect(session.turns).toBe(4);
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

describe("continuing on S2", () => {
	const contains = { scoring: { scorers: [{ kind: "contains" as const, name: "says-done", text: "DONE" }] } };
	it("starts the next turn on S2 after a turn ran out of budget on S2, and back on S1 after S2 succeeds", async () => {
		// Turn 1 escalates (verify_fail) and its S2 continuation runs out of the turn budget; turn 2 continues on S2.
		const { env, deps, cwd } = sessionEnv({
			config: { ...contains, budgets: { perRunUsd: 1, perSessionUsd: 10, perTurnShare: 0.1, estimateOutputTokens: 1 }, pricingOverrides: { "faux/slow": { input: 0, output: 100_000 } } },
		});
		const starts: string[] = [];
		env.faux.setResponses([
			fauxAssistantMessage("not yet"),
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "x" })]),
			fauxAssistantMessage("DONE"),
			fauxAssistantMessage("DONE again"),
		]);
		const session = createSession(deps, { cwd });
		const onEvent = (e: EngineEvent) => {
			if (e.type === "run_start" && e.depth === 0) starts.push(e.model);
		};
		const first = await session.turn("finish it", { onEvent });
		expect(first.continuationError).toMatchObject({ code: "BUDGET_EXCEEDED" });
		expect(session.continuesOnS2).toBe(true);
		const second = await session.turn("please continue", { onEvent });
		expect(starts).toEqual(["faux/fast", "faux/slow"]);
		expect(second.status).toBe("succeeded");
		expect(session.continuesOnS2).toBe(false);
		await session.turn("thanks", { onEvent });
		expect(starts.at(-1)).toBe("faux/fast");
	});

	it("carries S2 across resume, and /model or /clear override it", async () => {
		const { env, deps, cwd } = sessionEnv({ config: { budgets: { perRunUsd: 1, perSessionUsd: 10, perTurnShare: 0.1 } } });
		const starts: string[] = [];
		const onEvent = (e: EngineEvent) => {
			if (e.type === "run_start" && e.depth === 0) starts.push(e.model);
		};
		env.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized: bad key" }),
			fauxAssistantMessage("ok"),
			fauxAssistantMessage("ok"),
			fauxAssistantMessage("ok"),
		]);
		const session = createSession(deps, { cwd, model: "s2" });
		await session.turn("fails on s2", { onEvent });
		// A turn the user pinned to S2 is not carried: the override already decides the model.
		expect(session.continuesOnS2).toBe(false);
		session.setModel(null);
		expect(session.continuesOnS2).toBe(false);

		const carried = createSession(deps, { cwd });
		await carried.turn("warm up", { onEvent });
		// As if that turn had stopped on S2 (an empty session is not kept on close, so it needs a turn).
		(carried as unknown as { state: { continueOnS2: boolean } }).state.continueOnS2 = true;
		expect(carried.continuesOnS2).toBe(true);
		carried.setModel("s1");
		expect(carried.continuesOnS2).toBe(false);
		carried.setModel(null);
		expect(carried.continuesOnS2).toBe(true);
		carried.close();
		const resumed = resumeSession(deps, carried.id);
		expect(resumed.continuesOnS2).toBe(true);
		resumed.setModel("s1");
		await resumed.turn("pinned", { onEvent });
		expect(starts.at(-1)).toBe("faux/fast");
		resumed.setModel(null);
		// A turn on a model the user chose is the latest turn now, so nothing carries.
		expect(resumed.continuesOnS2).toBe(false);
		(resumed as unknown as { state: { continueOnS2: boolean } }).state.continueOnS2 = true;
		resumed.clear();
		expect(resumed.continuesOnS2).toBe(false);
		await resumed.turn("fresh", { onEvent });
		expect(starts.at(-1)).toBe("faux/fast");
		resumed.close();
	});
});

describe("shell commands", () => {
	it("runs a command in the workspace and hands its output to the next turn only", async () => {
		const { env, deps, cwd } = sessionEnv();
		const seen: string[][] = [];
		env.faux.setResponses([
			async (ctx) => {
				seen.push(texts(ctx));
				return fauxAssistantMessage("A1");
			},
			async (ctx) => {
				seen.push(texts(ctx));
				return fauxAssistantMessage("A2");
			},
		]);
		const session = createSession(deps, { cwd });
		const r = await session.shell("pwd; exit 3");
		expect(r).toMatchObject({ exitCode: 3, ended: "exited" });
		expect(r.output.trim()).toBe(cwd);
		expect(session.pendingShellCount).toBe(1);
		await session.shell("echo second");
		await session.turn("What happened?");
		expect(seen[0]).toHaveLength(1);
		const first = seen[0]?.[0] ?? "";
		expect(first).toMatch(/^user:\[nexo\] Before this message the user ran shell commands/);
		expect(first).toContain(`$ pwd; exit 3\n[exit code 3]\n${cwd}`);
		expect(first).toContain("$ echo second\n[exit code 0]\nsecond");
		expect(first.indexOf("$ pwd")).toBeLessThan(first.indexOf("$ echo second"));
		expect(first).toContain("[nexo] The user's message:\nWhat happened?");
		expect(session.title).toBe("What happened?");
		expect(session.pendingShellCount).toBe(0);
		await session.turn("Again");
		expect(seen[1]?.at(-1)).toMatch(/^user:Again/);
		expect(seen[1]?.filter((m) => m.includes("shell commands"))).toHaveLength(1);
		expect(session.turns).toBe(2);
	});

	it("keeps notes across a resume, drops them on clear, and redacts and caps the output", async () => {
		const { env, deps, cwd } = sessionEnv();
		let sent = "";
		env.faux.setResponses([
			fauxAssistantMessage("A0"),
			async (ctx) => {
				sent = texts(ctx).at(-1) ?? "";
				return fauxAssistantMessage("A1");
			},
		]);
		const secret = "sk-ant-api03-" + "x".repeat(40);
		const session = createSession(deps, { cwd });
		await session.turn("Q0");
		const r = await session.shell(`echo ${secret}; head -c 50000 /dev/zero | tr '\\0' 'a'; echo; echo tail-end`);
		expect(r.output).not.toContain(secret);
		session.close();
		const resumed = resumeSession(deps, session.id);
		expect(resumed.pendingShellCount).toBe(1);
		await resumed.turn("Q1");
		expect(sent).not.toContain(secret);
		expect(sent).toContain("tail-end");
		expect(sent).toMatch(/characters cut/);
		expect(sent.length).toBeLessThan(25_000);
		await resumed.shell("echo dropped");
		resumed.clear();
		expect(resumed.pendingShellCount).toBe(0);
		resumed.close();
	});

	it("records a stopped command and refuses an empty command or one during a turn", async () => {
		const { env, deps, cwd } = sessionEnv();
		let sent = "";
		let release = () => {};
		env.faux.setResponses([
			async () => {
				await new Promise<void>((r) => {
					release = r;
				});
				return fauxAssistantMessage("A1");
			},
			async (ctx) => {
				sent = texts(ctx).at(-1) ?? "";
				return fauxAssistantMessage("A2");
			},
		]);
		const session = createSession(deps, { cwd });
		await expect(session.shell("   ")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		expect(await session.shell("sleep 5", { signal: ac.signal })).toMatchObject({ ended: "aborted", exitCode: null });
		const turn = session.turn("Q1");
		await expect(session.shell("echo hi")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await new Promise((r) => setTimeout(r, 20));
		release();
		await turn;
		expect(session.pendingShellCount).toBe(0);
		await session.turn("Q2");
		expect(sent).toMatch(/^user:Q2/);
		expect(sent).not.toContain("shell commands");
	});
});

describe("session fixes", () => {
	it("lets a later turn read a large tool output saved by an earlier turn", async () => {
		const { env, deps, cwd } = sessionEnv();
		writeFileSync(join(cwd, "big.txt"), Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(10)}`).join("\n"));
		let pointer = "";
		let readBack = "";
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "big.txt" })]),
			async (ctx) => {
				pointer = /@tool_outputs\/[A-Z0-9]+\.txt/.exec(lastToolResultText(ctx))?.[0] ?? "missing";
				return fauxAssistantMessage("saw an excerpt");
			},
			async () => fauxAssistantMessage([fauxToolCall("read", { path: pointer, offset: 1500, limit: 1 })]),
			async (ctx) => {
				readBack = lastToolResultText(ctx);
				return fauxAssistantMessage("done");
			},
		]);
		const session = createSession(deps, { cwd, workspace: "." });
		await session.turn("read big.txt");
		expect(pointer).not.toBe("missing");
		await session.turn("now read line 1500 of the saved output");
		expect(readBack).toBe(`line 1499 ${"x".repeat(10)}`);
	});

	it("follows budgets.perSessionUsd from the reloaded config until /budget overrides it", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		let config = deps.config;
		let configHash = deps.configHash;
		const session = createSession({ ...deps, reloadConfig: () => ({ config, configHash }) }, { cwd });
		expect(session.budgetUsd).toBe(5);
		config = { ...deps.config, budgets: { ...deps.config.budgets, perSessionUsd: 7 } };
		configHash = "seven";
		await session.turn("one");
		expect(session.budgetUsd).toBe(7);
		expect(getSessionRow(deps.db, session.id)?.budgetUsd).toBe(7);
		session.setBudget(2);
		config = { ...deps.config, budgets: { ...deps.config.budgets, perSessionUsd: 9 } };
		configHash = "nine";
		await session.turn("two");
		expect(session.budgetUsd).toBe(2);
		session.close();
		expect(resumeSession(deps, session.id).budgetUsd).toBe(2);
	});

	it("rebuilds the redactor when the reloaded config changes its patterns", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		let config = deps.config;
		let configHash = deps.configHash;
		const session = createSession({ ...deps, reloadConfig: () => ({ config, configHash }) }, { cwd });
		await session.turn("first CUSTOM-123");
		config = { ...deps.config, redaction: { patterns: ["CUSTOM-\\d+"] } };
		configHash = "patterns";
		await session.turn("second CUSTOM-456");
		const raw = readFileSync(join(deps.paths.sessions, session.id, "transcript.jsonl"), "utf8");
		expect(raw).toContain("CUSTOM-123");
		expect(raw).not.toContain("CUSTOM-456");
		expect(raw).toContain(REDACTED);
	});

	it("keeps a requested compaction pending when the turn is aborted during it, and records the instruction", async () => {
		const { env, deps, cwd } = sessionEnv();
		const ac = new AbortController();
		env.faux.setResponses([
			fauxAssistantMessage("A1"),
			fauxAssistantMessage("A2"),
			fauxAssistantMessage("A3"),
			async () => {
				ac.abort();
				return fauxAssistantMessage("partial summary");
			},
		]);
		const session = createSession(deps, { cwd });
		await session.turn("Q1");
		await session.turn("Q2");
		await session.turn("Q3");
		session.compact();
		const aborted = await session.turn("Q4", { signal: ac.signal });
		expect(aborted.status).toBe("aborted");
		expect(session.compactPending).toBe(true);
		expect(session.turns).toBe(4);
		expect(session.transcript().some((l) => l.type === "compaction")).toBe(false);
		const last = session.transcript().at(-1);
		expect(last).toMatchObject({ type: "message", turnIndex: 4, message: { role: "user", content: [{ type: "text", text: "Q4" }] } });
	});

	it("does not reuse turn indexes of runs recorded after the last save", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("three")]);
		const session = createSession(deps, { cwd });
		await session.turn("one");
		insertRun(deps.db, runRow({ id: "crashed-turn", status: "aborted", sessionId: session.id, turnIndex: 2 }));
		session.close();
		const again = resumeSession(deps, session.id);
		expect(again.turns).toBe(2);
		expect(again.lastRunId).toBe("crashed-turn");
		const r = await again.turn("three");
		expect(getRun(deps.db, r.trajectoryId as string)?.turnIndex).toBe(3);
	});

	it("caps the compaction input by dropping the oldest lines first", () => {
		const messages = Array.from({ length: 40 }, (_, i) => ({ role: "user" as const, content: `MSG-${i} ${"y".repeat(5000)}`, timestamp: 0 }));
		const text = renderForSummary("PREVIOUS", messages, 50_000);
		expect(text.length).toBeLessThanOrEqual(50_000);
		expect(text).toContain("PREVIOUS");
		expect(text).toContain("MSG-39 ");
		expect(text).not.toContain("MSG-0 ");
	});

	it("locks an open session against a second opener and takes over a stale lock", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("ok")]);
		const session = createSession(deps, { cwd });
		await session.turn("hello");
		const err = (() => {
			try {
				resumeSession(deps, session.id);
			} catch (error) {
				return error as NexoError;
			}
			throw new Error("expected CONFLICT");
		})();
		expect(err.code).toBe("CONFLICT");
		expect(err.hint).toBeTruthy();
		session.close();
		const lock = join(deps.paths.sessions, session.id, "session.lock");
		expect(existsSync(lock)).toBe(false);
		writeFileSync(lock, "999999999");
		const again = resumeSession(deps, session.id);
		expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
		again.close();
	});

	it("refuses to close while a turn is running", async () => {
		const { env, deps, cwd } = sessionEnv();
		let release: () => void = () => {};
		env.faux.setResponses([() => new Promise((resolve) => (release = () => resolve(fauxAssistantMessage("slow"))))]);
		const session = createSession(deps, { cwd });
		const pending = session.turn("first");
		expectCode(() => session.close(), "CONFLICT");
		await new Promise((r) => setTimeout(r, 10));
		release();
		await pending;
		session.close();
		expect(session.status).toBe("closed");
	});
});

describe("empty sessions", () => {
	it("keeps a session whose first turn ran but could not be recorded", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("ok")]);
		const session = createSession(deps, { cwd });
		(session as unknown as { dir: { appendTranscript: () => void } }).dir.appendTranscript = () => {
			throw new Error("disk full");
		};
		await expect(session.turn("hello")).rejects.toThrow("disk full");
		expect(session.turns).toBe(0);
		session.close();
		expect(existsSync(session.dirPath)).toBe(true);
		expect(getSessionRow(deps.db, session.id)).toBeDefined();
		expect(listSessions(deps.db).map((s) => s.id)).toEqual([session.id]);
	});

	it("deletes a session that never ran a turn when it closes, and hides 0-turn sessions from listSessions", async () => {
		const { env, deps, cwd } = sessionEnv();
		const empty = createSession(deps, { cwd });
		const dir = empty.dirPath;
		expect(getSessionRow(deps.db, empty.id)).toBeDefined();
		empty.close();
		expect(existsSync(dir)).toBe(false);
		expect(getSessionRow(deps.db, empty.id)).toBeUndefined();

		env.faux.setResponses([fauxAssistantMessage("hi")]);
		const used = createSession(deps, { cwd });
		await used.turn("hello");
		used.close();
		expect(existsSync(used.dirPath)).toBe(true);
		const open = createSession(deps, { cwd });
		expect(listSessions(deps.db).map((s) => s.id)).toEqual([used.id]);
		open.close();
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

	it("rejects a missing --workspace directory", () => {
		const { deps, cwd } = sessionEnv();
		expectCode(() => createSession(deps, { cwd, workspace: join(cwd, "missing") }), "CONFIG_INVALID");
	});

	it("lists sessions most recently updated first", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
		const a = createSession(deps, { cwd });
		const b = createSession(deps, { cwd });
		await b.turn("older");
		await a.turn("latest");
		expect(listSessions(deps.db).map((s) => s.id)).toEqual([a.id, b.id]);
		expect(listSessions(deps.db, { limit: 1 })).toHaveLength(1);
		expect(existsSync(join(deps.paths.sessions, b.id, "session.json"))).toBe(true);
		expect(() => listSessions(deps.db, { limit: 0 })).toThrow();
	});
});

/** A prompter that allows every `ask` tool (bash). */
const allowAll: Prompter = { interactive: true, approve: async () => "once" };

function workspaceOf(result: { runDir: string | null }): string {
	return join(result.runDir as string, "workspace");
}

describe("turn workspaces", () => {
	it("works in each turn's run folder and carries the previous turn's files forward", async () => {
		const { env, deps, cwd } = sessionEnv({ prompter: allowAll });
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "made/a.txt", content: "from the write tool" })]),
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'from bash' > b.txt" })]),
			fauxAssistantMessage("made two files"),
			fauxAssistantMessage([fauxToolCall("edit", { path: "made/a.txt", oldText: "write tool", newText: "second turn" })]),
			fauxAssistantMessage("edited"),
		]);
		const session = createSession(deps, { cwd });
		expect(session.workspace).toBeNull();
		const r1 = await session.turn("make files");
		expect(r1.status).toBe("succeeded");
		const ws1 = workspaceOf(r1);
		expect(readFileSync(join(ws1, "made", "a.txt"), "utf8")).toBe("from the write tool");
		expect(readFileSync(join(ws1, "b.txt"), "utf8")).toBe("from bash");
		expect(readdirSync(cwd)).toEqual([]);
		const json1 = readRunJson(r1.runDir as string);
		expect(json1.workspace).toBe(ws1);
		expect(json1.workspaceFrom).toBeUndefined();

		const r2 = await session.turn("now edit it");
		expect(r2.status).toBe("succeeded");
		const ws2 = workspaceOf(r2);
		expect(ws2).not.toBe(ws1);
		expect(readFileSync(join(ws2, "made", "a.txt"), "utf8")).toBe("from the second turn");
		expect(readFileSync(join(ws2, "b.txt"), "utf8")).toBe("from bash");
		expect(readFileSync(join(ws1, "made", "a.txt"), "utf8")).toBe("from the write tool");
		const json2 = readRunJson(r2.runDir as string);
		expect(json2.workspace).toBe(ws2);
		expect(json2.workspaceFrom).toEqual({ runId: r1.trajectoryId, bytes: "from the write tool".length + "from bash".length });
		expect(readdirSync(cwd)).toEqual([]);
	});

	it("copies symlinks as symlinks, without following them", async () => {
		const { env, deps, cwd } = sessionEnv({ prompter: allowAll });
		const outside = join(cwd, "outside.txt");
		writeFileSync(outside, "outside");
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "a" })]), fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const session = createSession(deps, { cwd });
		const r1 = await session.turn("one");
		symlinkSync("a.txt", join(workspaceOf(r1), "rel-link"));
		symlinkSync(outside, join(workspaceOf(r1), "abs-link"));
		const r2 = await session.turn("two");
		const ws2 = workspaceOf(r2);
		expect(lstatSync(join(ws2, "rel-link")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(ws2, "rel-link"))).toBe("a.txt");
		expect(lstatSync(join(ws2, "abs-link")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(ws2, "abs-link"))).toBe(outside);
		expect(readRunJson(r2.runDir as string).workspaceFrom).toEqual({ runId: r1.trajectoryId, bytes: 1 });
	});

	it("keeps the files after /clear: only the conversation starts over", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "kept" })]), fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const session = createSession(deps, { cwd });
		await session.turn("one");
		session.clear();
		const r2 = await session.turn("two");
		expect(readFileSync(join(workspaceOf(r2), "a.txt"), "utf8")).toBe("kept");
	});

	it("shares a --workspace folder between turns and copies nothing into the run folders", async () => {
		const { env, deps, cwd } = sessionEnv();
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "nexo-explicit-")));
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "note.txt", content: "hi" })]),
			fauxAssistantMessage("wrote"),
			fauxAssistantMessage([fauxToolCall("edit", { path: "note.txt", oldText: "hi", newText: "hello" })]),
			fauxAssistantMessage("edited"),
		]);
		const session = createSession(deps, { cwd, workspace: dir });
		expect(session.workspace).toBe(dir);
		const r1 = await session.turn("write a note");
		const r2 = await session.turn("edit it");
		expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("hello");
		for (const r of [r1, r2]) {
			expect(readRunJson(r.runDir as string).workspace).toBe(dir);
			expect(readRunJson(r.runDir as string).workspaceFrom).toBeUndefined();
			expect(readdirSync(workspaceOf(r))).toEqual([]);
		}
		expect(JSON.parse(readFileSync(join(deps.paths.sessions, session.id, "session.json"), "utf8")).workspace).toBe(dir);
	});

	it("works in the current folder with --workspace .", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "note.txt", content: "hi" })]), fauxAssistantMessage("wrote")]);
		const session = createSession(deps, { cwd, workspace: "." });
		expect(session.workspace).toBe(cwd);
		await session.turn("write a note");
		expect(readFileSync(join(cwd, "note.txt"), "utf8")).toBe("hi");
	});

	it("carries forward from the last turn after a resume", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "turn one" })]), fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const session = createSession(deps, { cwd });
		const r1 = await session.turn("one");
		session.close();
		expect(JSON.parse(readFileSync(join(deps.paths.sessions, session.id, "session.json"), "utf8")).workspace).toBeNull();
		const resumed = resumeSession(deps, session.id);
		expect(resumed.workspace).toBeNull();
		const r2 = await resumed.turn("two");
		expect(readFileSync(join(workspaceOf(r2), "a.txt"), "utf8")).toBe("turn one");
		expect(readRunJson(r2.runDir as string).workspaceFrom).toMatchObject({ runId: r1.trajectoryId });
		resumed.close();
	});

	it("keeps an older session's workspace folder on resume", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage([fauxToolCall("write", { path: "b.txt", content: "b" })]), fauxAssistantMessage("two")]);
		const session = createSession(deps, { cwd });
		await session.turn("one");
		session.close();
		// A session.json written before run-folder sessions: the workspace is the folder nexo was started in.
		const file = join(deps.paths.sessions, session.id, "session.json");
		writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), workspace: cwd }));
		const resumed = resumeSession(deps, session.id);
		expect(resumed.workspace).toBe(cwd);
		const r2 = await resumed.turn("two");
		expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("b");
		expect(readRunJson(r2.runDir as string).workspace).toBe(cwd);
		expect(readRunJson(r2.runDir as string).workspaceFrom).toBeUndefined();
		resumed.close();
	});

	it("runs ! commands in the folder nexo was started in before the first turn, then in the latest turn's workspace", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const session = createSession(deps, { cwd });
		expect(session.shellDir).toBe(cwd);
		expect((await session.shell("pwd")).output.trim()).toBe(cwd);
		const r1 = await session.turn("one");
		expect(session.shellDir).toBe(workspaceOf(r1));
		expect((await session.shell("pwd; printf x > from-shell.txt")).output.trim()).toBe(realpathSync(workspaceOf(r1)));
		const r2 = await session.turn("two");
		expect(readFileSync(join(workspaceOf(r2), "from-shell.txt"), "utf8")).toBe("x");
	});

	it("refuses write tool writes into other runs' folders and the sessions folder under the nexo home", async () => {
		const { env, deps, cwd } = sessionEnv();
		const results: string[] = [];
		const capture = (next: ReturnType<typeof fauxAssistantMessage>) => async (ctx: TranscriptContext) => {
			results.push(lastToolResultText(ctx));
			return next;
		};
		const first = createSession(deps, { cwd });
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "a" })]), fauxAssistantMessage("one")]);
		const r1 = await first.turn("one");
		const otherRun = r1.trajectoryId as string;
		// Sessions whose --workspace lies inside the nexo home: only a run's own workspace is writable there.
		const inRuns = createSession(deps, { cwd, workspace: deps.paths.runs });
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: `${otherRun}/workspace/x.txt`, content: "x" })]),
			capture(fauxAssistantMessage([fauxToolCall("write", { path: join(deps.paths.runs, otherRun, "run.json"), content: "{}" })])),
			capture(fauxAssistantMessage("two")),
		]);
		await inRuns.turn("two");
		const inSessions = createSession(deps, { cwd, workspace: deps.paths.sessions });
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: join(first.id, "session.json"), content: "{}" })]), capture(fauxAssistantMessage("three"))]);
		await inSessions.turn("three");
		expect(results).toHaveLength(3);
		for (const text of results) expect(text).toMatch(/^TOOL_DENIED: Path ".*" is inside the nexo home/);
		expect(existsSync(join(deps.paths.runs, otherRun, "workspace", "x.txt"))).toBe(false);
		expect(readRunJson(join(deps.paths.runs, otherRun)).id).toBe(otherRun);
		expect(JSON.parse(readFileSync(join(deps.paths.sessions, first.id, "session.json"), "utf8")).id).toBe(first.id);
	});

	it("ends a turn aborted before it starts without copying the previous workspace", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "a" })]), fauxAssistantMessage("one")]);
		const session = createSession(deps, { cwd });
		await session.turn("one");
		const ac = new AbortController();
		ac.abort();
		const r2 = await session.turn("two", { signal: ac.signal });
		expect(r2.status).toBe("aborted");
		expect(readdirSync(workspaceOf(r2))).toEqual([]);
	});

	it("looks up the folder for ! commands once per turn, not on every read", async () => {
		const { env, deps, cwd } = sessionEnv();
		env.faux.setResponses([fauxAssistantMessage("one")]);
		const session = createSession(deps, { cwd });
		const r1 = await session.turn("one");
		expect(session.shellDir).toBe(workspaceOf(r1));
		const prepare = vi.spyOn(deps.db, "prepare");
		for (let i = 0; i < 5; i++) expect(session.shellDir).toBe(workspaceOf(r1));
		expect(prepare).not.toHaveBeenCalled();
		prepare.mockRestore();
	});
});

describe("approvals in sessions", () => {
	it("adds rules from Always allow during a turn, keeps them across /clear and --resume, and removes them", async () => {
		const { env, deps, cwd } = sessionEnv({ config: { tools: { policy: { bash: "ask" } } } });
		const asked: string[] = [];
		deps.prompter = { interactive: true, approve: async (r) => (asked.push(r.question), "always") };
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo one" })]),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo two" })]),
			fauxAssistantMessage("done"),
		]);
		const session = createSession(deps, { cwd });
		await session.turn("echo twice");
		expect(asked).toHaveLength(1);
		expect(session.sessionRules).toEqual([{ tool: "bash", kind: "prefix", value: "echo" }]);
		session.addSessionRule({ tool: "bash", kind: "prefix", value: "echo" });
		expect(session.sessionRules).toHaveLength(1);
		session.clear();
		expect(session.sessionRules).toHaveLength(1);
		session.close();
		const resumed = resumeSession(deps, session.id);
		expect(resumed.sessionRules).toEqual([{ tool: "bash", kind: "prefix", value: "echo" }]);
		expect(() => resumed.removeSessionRule(2)).toThrow(/INVALID_REQUEST|no rule/i);
		expect(resumed.removeSessionRule(1)).toEqual({ tool: "bash", kind: "prefix", value: "echo" });
		resumed.addSessionRule({ tool: "write", kind: "tool" });
		expect(resumed.clearSessionRules()).toBe(1);
		resumed.close();
	});

	it("/auto overrides the config per session and survives resume; older session files follow the config", async () => {
		const { deps, cwd, env } = sessionEnv({ config: { tools: { autoApprove: "on" } } });
		env.faux.setResponses([fauxAssistantMessage("ok")]);
		const session = createSession(deps, { cwd });
		expect(session.autoApprove).toBe(true);
		expect(session.autoApproveOverride).toBeNull();
		session.setAutoApprove(false);
		await session.turn("hi");
		session.close();
		const resumed = resumeSession(deps, session.id);
		expect(resumed.autoApprove).toBe(false);
		resumed.setAutoApprove(null);
		expect(resumed.autoApprove).toBe(true);
		resumed.close();
		// An older session.json without the new fields.
		const file = join(deps.paths.sessions, session.id, "session.json");
		const json = JSON.parse(readFileSync(file, "utf8"));
		delete json.sessionRules;
		delete json.autoApprove;
		writeFileSync(file, JSON.stringify(json));
		const old = resumeSession(deps, session.id);
		expect(old.sessionRules).toEqual([]);
		expect(old.autoApprove).toBe(true);
		old.close();
	});
});
