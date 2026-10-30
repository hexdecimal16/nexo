import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { EngineEvent } from "@nexo/core";
import { afterEach, describe, expect, it } from "vitest";
import { createNexo } from "../src/index.ts";
import { trackRunTree } from "../src/run-tree.ts";

const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("trackRunTree loop guard", () => {
	it("counts loop_guard events per run and ignores context_trim", () => {
		const tree = trackRunTree();
		tree.onEvent({ type: "run_start", runId: "r", parentRunId: null, instruction: "x", depth: 0, model: "faux/fast", effort: "low" });
		const guard = (kind: "repeat" | "max_tool_calls"): EngineEvent => ({ type: "loop_guard", runId: "r", depth: 0, toolCallId: "t", toolName: "bash", kind, count: 4, limit: 3 });
		tree.onEvent(guard("repeat"));
		tree.onEvent(guard("max_tool_calls"));
		tree.onEvent({ type: "context_trim", runId: "r", depth: 0, cleared: 2, tokensBefore: 100, tokensAfter: 50 });
		expect(tree.get("r")?.loopGuards).toBe(2);
		tree.onEvent(guard("repeat"));
		expect(tree.get("r")?.loopGuards).toBe(3);
	});
});

describe("nexo.reviewQueue", () => {
	it("lists a finished run, honours options and refuses after close", async () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-sdk-rq-"));
		roots.push(root);
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "config.json"), JSON.stringify({ models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "fast" } }, providers: { faux: { retryBaseDelayMs: 0, rateLimitBaseDelayMs: 0 } }, learning: { enabled: false } }));
		const faux = fauxProvider({ models: [{ id: "fast", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
		faux.setResponses([fauxAssistantMessage("hi"), fauxAssistantMessage("hi again")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const nexo = createNexo({ home, cwd: root, env: { PATH: process.env.PATH }, models });
		const first = await nexo.run({ instruction: "Say hi", budgetUsd: 0.5 });
		const second = await nexo.run({ instruction: "Say hi again", budgetUsd: 0.5 });
		const queue = nexo.reviewQueue();
		expect(queue.map((i) => i.runId).sort()).toEqual([first.trajectoryId, second.trajectoryId].sort());
		expect(nexo.reviewQueue({ limit: 1 })).toHaveLength(1);
		expect(nexo.reviewQueue({ now: new Date(Date.now() + 30 * 86_400_000) })).toEqual([]);
		await nexo.close();
		expect(() => nexo.reviewQueue()).toThrow();
	});
});
