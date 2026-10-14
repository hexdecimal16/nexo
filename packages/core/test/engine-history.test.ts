import { fauxAssistantMessage, fauxText, fauxToolCall, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getRun, getSpent, listSpans, readRunJson } from "@nexo/store";
import { createEngine, type EngineEvent } from "../src/index.ts";
import { makeEnv, useDispatcher } from "./helpers.ts";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

function texts(ctx: TranscriptContext): string[] {
	return ctx.messages
		.filter((m) => m.role !== "system")
		.map((m) => {
			if (typeof m.content === "string") return `${m.role}:${m.content}`;
			return `${m.role}:${m.content.map((b) => ("text" in b ? b.text : "")).join("")}`;
		});
}

describe("engine history and session links", () => {
	it("seeds the history before the instruction and returns the run's new messages", async () => {
		const env = makeEnv();
		let seen: string[] = [];
		env.faux.setResponses([
			async (ctx) => {
				seen = texts(ctx);
				return fauxAssistantMessage("Second answer.");
			},
		]);
		const earlier = fauxAssistantMessage("First answer.");
		const result = await createEngine(env.deps).run({
			instruction: "Second question",
			history: [{ role: "system", content: "dropped", timestamp: 1 }, user("First question"), earlier],
		});
		expect(result.status).toBe("succeeded");
		expect(seen[0]).toBe("user:First question");
		expect(seen[1]).toBe("assistant:First answer.");
		expect(seen[2]).toMatch(/^user:Second question/);
		expect(seen.join("\n")).not.toContain("dropped");
		expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(result.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "Second question" }] });
		expect(result.model).toMatchObject({ provider: "faux", id: "fast", effort: "off" });
		expect(result.model?.contextWindow).toBeGreaterThan(0);
	});

	it("records the session link on the root run and charges the session ledger, children included", async () => {
		const env = makeEnv();
		useDispatcher(env, {
			PARENT: [fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "a", instruction: "CHILD-A" }] })]), fauxAssistantMessage("done")],
			"CHILD-A": [fauxAssistantMessage("child done")],
		});
		const result = await createEngine(env.deps).run({ instruction: "PARENT", sessionId: "sess1", turnIndex: 3 });
		expect(result.status).toBe("succeeded");
		const id = result.trajectoryId as string;
		expect(readRunJson(result.runDir as string)).toMatchObject({ sessionId: "sess1", turnIndex: 3 });
		expect(getRun(env.deps.db, id)).toMatchObject({ sessionId: "sess1", turnIndex: 3 });
		expect(getSpent(env.deps.db, "session:sess1")).toBeCloseTo(result.costUsd, 10);
		expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("emits tool_start, tool_end and llm_end events", async () => {
		const env = makeEnv();
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		env.faux.setResponses([
			fauxAssistantMessage([fauxText("Writing."), fauxToolCall("write", { path: "a.txt", content: "hi" })]),
			fauxAssistantMessage("Done."),
		]);
		const result = await createEngine(env.deps).run({ instruction: "write" });
		const start = events.find((e) => e.type === "tool_start");
		const end = events.find((e) => e.type === "tool_end");
		expect(start).toMatchObject({ toolName: "write", args: { path: "a.txt", content: "hi" } });
		expect(end).toMatchObject({ toolName: "write", isError: false, toolCallId: (start as { toolCallId: string }).toolCallId });
		expect((end as { preview: string }).preview.length).toBeGreaterThan(0);
		const llm = events.filter((e) => e.type === "llm_end");
		expect(llm).toHaveLength(2);
		expect(llm.reduce((sum, e) => sum + (e as { costUsd: number }).costUsd, 0)).toBeCloseTo(result.costUsd, 10);
	});

	it("redacts a tool_end preview before cutting it", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "nexo-ws-"));
		writeFileSync(join(workspace, "big.txt"), `${"a".repeat(1990)}sk-ant-abcdefghijklmnopqrstuvwxyz0123 ${"b".repeat(100)}`);
		const env = makeEnv();
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "big.txt" })]), fauxAssistantMessage("read")]);
		await createEngine(env.deps).run({ instruction: "read big", workspace });
		const end = events.find((e) => e.type === "tool_end") as { preview: string; output: string };
		expect(end.preview).not.toContain("sk-ant");
		expect(end.preview.length).toBeLessThanOrEqual(2000);
		expect(end.output).not.toContain("sk-ant");
		expect(end.output).toContain("b".repeat(100));
	});

	it("lets prepareHistory replace the history using a compaction span charged to the run", async () => {
		const env = makeEnv();
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		let seen: string[] = [];
		let summarySystem = "";
		env.faux.setResponses([
			async (ctx) => {
				summarySystem = JSON.stringify(ctx.messages[0]);
				return fauxAssistantMessage("SUMMARY OF EARLIER");
			},
			async (ctx) => {
				seen = texts(ctx);
				return fauxAssistantMessage("Answer.");
			},
		]);
		let estimate = 0;
		const result = await createEngine(env.deps).run({
			instruction: "Next",
			history: [user("old question"), fauxAssistantMessage("old answer")],
			prepareHistory: async (ctx) => {
				estimate = ctx.estimateTokens(ctx.history);
				const summary = await ctx.summarize({ system: "Summarize the conversation.", text: "old question / old answer" });
				return [user(`Summary: ${summary}`)];
			},
		});
		expect(result.status).toBe("succeeded");
		expect(estimate).toBeGreaterThan(0);
		expect(summarySystem).toContain("Summarize the conversation.");
		expect(seen[0]).toBe("user:Summary: SUMMARY OF EARLIER");
		expect(seen.join("\n")).not.toContain("old answer");
		const spans = listSpans(env.deps.db, result.trajectoryId as string);
		const compaction = spans.find((s) => s.kind === "compaction");
		expect(compaction).toMatchObject({ status: "ok", model: "fast", tier: "s1" });
		expect(compaction?.costUsd).toBeGreaterThan(0);
		const llmCost = spans.filter((s) => s.kind === "llm_call").reduce((sum, s) => sum + s.costUsd, 0);
		expect(result.costUsd).toBeCloseTo(llmCost + (compaction?.costUsd ?? 0), 10);
		expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["compaction_start", "compaction_end"]));
		expect(events.find((e) => e.type === "compaction_end")).toMatchObject({ ok: true });
		expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("returns the partial messages of an aborted run", async () => {
		const env = makeEnv();
		const ac = new AbortController();
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })]),
			async () => {
				ac.abort();
				return fauxAssistantMessage("never seen");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "abort me" }, ac.signal);
		expect(result.status).toBe("aborted");
		expect(result.messages.slice(0, 3).map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
	});
});
