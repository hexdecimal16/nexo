import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, insertRun, insertSpan, openDb, RunDir, type RunJson, type RunRow } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { runRow, spanRow } from "../../store/test/fixtures.ts";

export const XSS = `<img src=x onerror="alert(1)"><script>alert('x')</script>`;

export interface Fixture {
	home: string;
	db: Db;
	root: RunRow;
	child: RunRow;
	running: RunRow;
	deleted: RunRow;
	ids: { runSpan: string; subagentSpan: string; childLlmSpan: string };
}

function runJson(row: RunRow, overrides: Partial<RunJson> = {}): RunJson {
	return {
		id: row.id,
		parentRunId: row.parentRunId,
		rootRunId: row.rootRunId,
		instruction: row.instruction,
		skill: row.skill,
		status: row.status,
		model: { provider: "faux", id: "fast", effort: "low", source: "skill", role: "s1" },
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		costUsd: row.costUsd,
		costUnknown: row.costUnknown,
		tokensIn: 0,
		tokensOut: 0,
		output: `final ${XSS}`,
		error: null,
		artifactSetId: null,
		configSnapshotHash: "h",
		workspace: "/w",
		taskGraphs: [],
		...overrides,
	};
}

/**
 * A NEXO_HOME with: a finished root run (skill "report") whose subagent child has a tool span with hostile output,
 * a changes/ diff, an offloaded tool output and a symlink that points outside the run; a run still running; and a
 * run whose directory was deleted after indexing.
 */
export function buildFixture(): Fixture {
	const home = mkdtempSync(join(tmpdir(), "nexo-web-"));
	const runsRoot = join(home, "runs");
	const db = openDb(join(home, "nexo.db"));
	const redact = createRedactor();

	const rootBase = runRow({ skill: "report", instruction: `Summarize ${XSS}`, status: "succeeded", startedAt: "2026-10-10T10:00:00.000Z", endedAt: "2026-10-10T10:00:10.000Z", costUsd: 0.03, modelFinal: "faux/fast", tierFinal: "s1" });
	const rootDir = RunDir.create(runsRoot, rootBase.id, redact);
	const root: RunRow = { ...rootBase, dirPath: rootDir.root };
	const childBase = runRow({ parentRunId: root.id, rootRunId: root.id, instruction: "sub task", status: "failed", startedAt: "2026-10-10T10:00:03.000Z", endedAt: "2026-10-10T10:00:08.000Z", costUsd: 0.01, costUnknown: true });
	const childDir = rootDir.child(childBase.id);
	const child: RunRow = { ...childBase, dirPath: childDir.root };
	insertRun(db, root);
	insertRun(db, child);
	rootDir.writeRunJson(runJson(root));
	childDir.writeRunJson(runJson(child));

	const runSpan = spanRow(root.id, { kind: "run", name: "skill:report", status: "ok", startedAt: "2026-10-10T10:00:00.000Z", endedAt: "2026-10-10T10:00:10.000Z", attrs: { instruction: root.instruction } });
	const llm = spanRow(root.id, { parentSpanId: runSpan.id, status: "ok", startedAt: "2026-10-10T10:00:01.000Z", endedAt: "2026-10-10T10:00:02.000Z", costUsd: 0.02, modelSource: "skill", attrs: { content: [{ type: "text", text: XSS }, { type: "toolCall", id: "t1", name: "spawn", arguments: { tasks: [] } }] } });
	const spawn = spanRow(root.id, { kind: "tool_call", name: "spawn", parentSpanId: runSpan.id, status: "ok", startedAt: "2026-10-10T10:00:02.000Z", endedAt: "2026-10-10T10:00:09.000Z", model: null, provider: null, tier: null, effort: null, modelSource: null, attrs: { args: { tasks: [{ id: "a" }] } } });
	const subagent = spanRow(root.id, { kind: "subagent", name: "a", parentSpanId: spawn.id, status: "error", queuedMs: 1000, startedAt: "2026-10-10T10:00:03.000Z", endedAt: "2026-10-10T10:00:08.000Z", model: null, provider: null, tier: null, effort: null, modelSource: null, attrs: { trajectoryId: child.id, childCostUsd: 0.01 } });
	const childRun = spanRow(child.id, { kind: "run", name: "run", status: "error", startedAt: "2026-10-10T10:00:03.000Z", endedAt: "2026-10-10T10:00:08.000Z", attrs: { parentSpanId: subagent.id } });
	const childLlm = spanRow(child.id, { parentSpanId: childRun.id, status: "ok", startedAt: "2026-10-10T10:00:04.000Z", endedAt: "2026-10-10T10:00:05.000Z", costUnknown: true, payloadRef: "tool_outputs/big.txt" });
	const childTool = spanRow(child.id, { kind: "tool_call", name: "bash", parentSpanId: childRun.id, status: "error", startedAt: "2026-10-10T10:00:05.000Z", endedAt: "2026-10-10T10:00:06.000Z", attrs: { args: { command: XSS }, result: XSS } });
	for (const s of [runSpan, llm, spawn, subagent, childRun, childLlm, childTool]) insertSpan(db, s);

	mkdirSync(join(root.dirPath, "changes", "after"), { recursive: true });
	writeFileSync(join(root.dirPath, "changes", "changes.diff"), `--- a/x.html\n+++ b/x.html\n@@ -1 +1 @@\n-old\n+${XSS}\n`);
	writeFileSync(join(root.dirPath, "changes", "after", "x.html"), XSS);
	writeFileSync(join(child.dirPath, "tool_outputs", "big.txt"), "y".repeat(2 * 1024 * 1024));
	writeFileSync(join(home, "secret.txt"), "outside the run");
	symlinkSync(join(home, "secret.txt"), join(root.dirPath, "artifacts", "escape.txt"));

	const runningBase = runRow({ instruction: "still going", status: "running", startedAt: "2026-10-10T11:00:00.000Z" });
	const runningDir = RunDir.create(runsRoot, runningBase.id, redact);
	const running: RunRow = { ...runningBase, dirPath: runningDir.root };
	insertRun(db, running);
	runningDir.writeRunJson(runJson(running));
	insertSpan(db, spanRow(running.id, { kind: "run", name: "run", status: "running", startedAt: "2026-10-10T11:00:00.000Z" }));

	const deletedBase = runRow({ instruction: "gone", status: "succeeded", startedAt: "2026-10-10T09:00:00.000Z", endedAt: "2026-10-10T09:00:01.000Z" });
	const deletedDir = RunDir.create(runsRoot, deletedBase.id, redact);
	const deleted: RunRow = { ...deletedBase, dirPath: deletedDir.root };
	insertRun(db, deleted);
	rmSync(deletedDir.root, { recursive: true });

	return { home, db, root, child, running, deleted, ids: { runSpan: runSpan.id, subagentSpan: subagent.id, childLlmSpan: childLlm.id } };
}
