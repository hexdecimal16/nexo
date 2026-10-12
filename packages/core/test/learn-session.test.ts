import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listLearnJobs, listMemories } from "@nexo/store";
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
});
