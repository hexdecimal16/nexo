import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { curateWikiKnowledge, wikiCuratorPrompt } from "../src/learn/wiki.ts";
import { finishedRun, makeEnv, script } from "./learn-helpers.ts";
import { RunBudget } from "../src/cost/budget.ts";
import { Recorder } from "../src/engine/recorder.ts";
import { getRun, RunDir } from "@nexo/store";

describe("wiki curator", () => {
	it("formats the curator prompt with existing wikis", () => {
		const prompt = wikiCuratorPrompt({
			instruction: "Explain Transformer architecture",
			output: "Transformers use multi-head self-attention.",
			existingWikis: ["ai", "math"],
		});
		expect(prompt).toContain("ai, math");
		expect(prompt).toContain("Explain Transformer architecture");
		expect(prompt).toContain("multi-head self-attention");
	});

	it("creates a new wiki and files a page when durable knowledge is proposed", async () => {
		const baseEnv = makeEnv();
		const wikisDir = mkdtempSync(join(tmpdir(), "nexo-test-wikis-"));
		baseEnv.deps.paths = { ...baseEnv.deps.paths, wikis: wikisDir };

		script(baseEnv, [
			"Raft is a leader-based consensus algorithm that manages replicated logs across distributed nodes.",
			JSON.stringify({
				pages: [
					{
						wikiName: "distributed-systems",
						path: "concepts/raft.md",
						summary: "Raft is a leader-based consensus algorithm.",
						content: "# Raft Consensus\n\nRaft elects a leader and replicates logs.",
					},
				],
			}),
		]);

		const { result, learnEnv } = await finishedRun(baseEnv, { instruction: "Summarize the raft consensus protocol" });
		const runId = result.trajectoryId as string;
		const run = getRun(baseEnv.deps.db, runId)!;

		const budget = new RunBudget(1);
		const recorder = new Recorder({
			db: baseEnv.deps.db,
			runDir: new RunDir(run.dirPath, run.id, baseEnv.deps.redact),
			runId: run.id,
			now: learnEnv.now,
			redact: baseEnv.deps.redact,
		});

		const deps = {
			env: learnEnv,
			recorder,
			parentSpanId: "span-1",
			budget,
			charge: () => {},
			signal: new AbortController().signal,
		};

		const outcome = await curateWikiKnowledge(deps, run, result.output as string, []);
		expect(outcome.pagesCreated).toBe(1);
		expect(outcome.wikisTouched).toEqual(["distributed-systems"]);

		const pageFile = join(wikisDir, "distributed-systems", "concepts", "raft.md");
		expect(existsSync(pageFile)).toBe(true);
		const content = readFileSync(pageFile, "utf8");
		expect(content).toContain("summary: Raft is a leader-based consensus algorithm.");
		expect(content).toContain("sources: [run:" + runId + "]");
		expect(content).toContain("# Raft Consensus");

		// Index & AGENTS should also be created
		expect(existsSync(join(wikisDir, "distributed-systems", "AGENTS.md"))).toBe(true);
		expect(existsSync(join(wikisDir, "distributed-systems", "index.md"))).toBe(true);
		expect(existsSync(join(wikisDir, "distributed-systems", "log.md"))).toBe(true);
	});
});
