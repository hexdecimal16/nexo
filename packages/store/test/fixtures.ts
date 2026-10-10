import { newId, type RunRow, type SpanRow } from "../src/index.ts";

/** A complete `runs` row with neutral defaults; tests override only the fields they assert on. */
export function runRow(overrides: Partial<RunRow> = {}): RunRow {
	const id = overrides.id ?? newId();
	return {
		id,
		parentRunId: null,
		rootRunId: id,
		dirPath: `/tmp/runs/${id}`,
		instruction: "do it",
		skill: null,
		status: "running",
		configSnapshotHash: "h",
		artifactSetId: null,
		modelFinal: null,
		tierFinal: null,
		escalations: 0,
		startedAt: "2026-10-10T00:00:00.000Z",
		endedAt: null,
		costUsd: 0,
		costUnknown: false,
		tokensIn: 0,
		tokensOut: 0,
		pid: null,
		error: null,
		...overrides,
	};
}

/** A complete `spans` row (an `llm_call` on faux/fast) with neutral defaults. */
export function spanRow(runId: string, overrides: Partial<SpanRow> = {}): SpanRow {
	return {
		id: newId(),
		runId,
		parentSpanId: null,
		kind: "llm_call",
		name: "fast",
		status: "running",
		startedAt: "2026-10-10T00:00:01.000Z",
		endedAt: null,
		queuedMs: null,
		model: "fast",
		provider: "faux",
		tier: "s1",
		effort: "off",
		modelSource: "default",
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		costUsd: 0,
		costUnknown: false,
		payloadRef: null,
		attrs: {},
		...overrides,
	};
}
