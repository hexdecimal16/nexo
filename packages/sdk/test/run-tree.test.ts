import type { EngineEvent } from "@nexo/core";
import { describe, expect, it } from "vitest";
import { trackRunTree } from "../src/run-tree.ts";

const start = (runId: string, parentRunId: string | null, taskId?: string): EngineEvent => ({
	type: "run_start",
	runId,
	parentRunId,
	instruction: `do ${runId}`,
	depth: parentRunId ? 1 : 0,
	model: "faux/fast",
	effort: "low",
	...(taskId ? { taskId } : {}),
});

describe("trackRunTree", () => {
	it("nests subagents under their parent and tracks tools, cost and errors", () => {
		const tree = trackRunTree();
		for (const e of [
			start("root", null),
			start("kid", "root", "research"),
			{ type: "tool_start", runId: "kid", depth: 1, toolName: "web_fetch", toolCallId: "t1", args: {} } as EngineEvent,
			{ type: "llm_end", runId: "kid", depth: 1, costUsd: 0.01, costUnknown: false, tokensIn: 1, tokensOut: 1 } as EngineEvent,
		])
			tree.onEvent(e);
		const kid = tree.get("kid");
		expect(kid).toMatchObject({ taskId: "research", status: "running", toolCalls: 1, currentTool: "web_fetch" });
		tree.onEvent({ type: "run_end", runId: "kid", depth: 1, status: "failed", costUsd: 0.02, error: { code: "PROVIDER_UNAVAILABLE", message: "stalled" } });
		tree.onEvent({ type: "run_end", runId: "root", depth: 0, status: "succeeded", costUsd: 0.05 });
		expect(tree.roots()).toHaveLength(1);
		expect(tree.roots()[0]?.children).toEqual([kid]);
		expect(kid).toMatchObject({ status: "failed", currentTool: null, costUsd: 0.02, error: { code: "PROVIDER_UNAVAILABLE" } });
	});
});
