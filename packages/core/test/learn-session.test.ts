import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSystemMessageText, type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { addMemory, listLearnJobs, listMemories, listSpans } from "@nexo/store";
import { createSession } from "../src/index.ts";
import { delta, lesson, makeEnv, reflection, script } from "./learn-helpers.ts";

function cwd(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "nexo-learn-cwd-")));
}

describe("learning in a session", () => {
	it("learns from each turn in the background and re-reflects after /notdone with the human lesson stored first", async () => {
		const env = makeEnv();
		const s = script(env, [
			"Turn one answer.",
			reflection([lesson("Answer in one line")]),
			delta([{ op: "add", type: "preference", scope: "user", content: "Answer in one line", importance: 0.6 }]),
			reflection(),
		]);
		const session = createSession(env.deps, { cwd: cwd() });
		const result = await session.turn("Explain the build");
		await session.learnIdle();
		expect(listLearnJobs(env.deps.db, { runId: result.trajectoryId as string })).toEqual([expect.objectContaining({ trigger: "run_end", status: "succeeded" })]);
		expect(listMemories(env.deps.db).map((m) => [m.source, m.content])).toEqual([["ace", "Answer in one line"]]);

		session.review("not_done", "it skipped the tests");
		expect(listMemories(env.deps.db).map((m) => m.source).sort()).toEqual(["ace", "human"]);
		await session.learnIdle();
		expect(listLearnJobs(env.deps.db, { runId: result.trajectoryId as string }).map((j) => [j.trigger, j.status])).toEqual([
			["feedback", "succeeded"],
			["run_end", "succeeded"],
		]);
		expect(s.prompts[3]).toContain("not_done: it skipped the tests");
		session.close();
	});

	it("writes no human lesson and enqueues nothing with learning off", async () => {
		const env = makeEnv({ config: { learning: { enabled: false } } });
		script(env, ["answer"]);
		const session = createSession(env.deps, { cwd: cwd() });
		await session.turn("hi");
		session.review("not_done", "wrong");
		await session.learnIdle();
		expect(listMemories(env.deps.db)).toEqual([]);
		expect(listLearnJobs(env.deps.db)).toEqual([]);
		session.close();
	});
	it("retrieves memories once, at the session's first turn, and reuses the same block for later turns", async () => {
		const env = makeEnv({ config: { learning: { enabled: false } } });
		const now = new Date().toISOString();
		addMemory(env.deps.db, { scope: "user", type: "preference", content: "Use pnpm, never npm", importance: 0.9, source: "user" }, env.deps.redact, now);
		const systems: string[] = [];
		const factory: FauxResponseFactory = async (context) => {
			systems.push(context.messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n"));
			return fauxAssistantMessage("ok");
		};
		env.faux.setResponses(Array.from({ length: 4 }, () => factory));
		const session = createSession(env.deps, { cwd: cwd() });
		const first = await session.turn("Install the pnpm dependencies");
		addMemory(env.deps.db, { scope: "user", type: "fact", content: "The build uses pnpm workspaces", importance: 1, source: "user" }, env.deps.redact, now);
		const second = await session.turn("Now explain the pnpm workspaces build");
		const block = (text: string) => text.slice(text.indexOf("# Notes from memory"));
		expect(systems).toHaveLength(2);
		expect(block(systems[0] ?? "")).toContain("Use pnpm, never npm");
		expect(block(systems[1] ?? "")).toBe(block(systems[0] ?? ""));
		expect(listSpans(env.deps.db, first.trajectoryId as string).filter((sp) => sp.kind === "memory_read")).toHaveLength(1);
		expect(listSpans(env.deps.db, second.trajectoryId as string).filter((sp) => sp.kind === "memory_read")).toEqual([]);
		session.close();
	});
});
