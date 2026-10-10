import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { transaction } from "./db.ts";
import { restoreFeedback } from "./feedback.ts";
import { readRunJson, readTrajectory, type RunJson } from "./run-dir.ts";
import { insertRun } from "./runs.ts";
import { insertSpan } from "./spans.ts";

export interface ReindexResult {
	runs: number;
	spans: number;
	skipped: string[];
}

/**
 * Rebuilds the `runs` and `spans` tables from run directories. Run directories are the source of truth.
 * The feedback table is kept; a run with no feedback rows gets one back from its run.json `humanVerdict`.
 * A run.json still marked running is indexed as aborted, because a reindexed row has no pid for crash recovery to check.
 */
export function reindex(db: Db, runsRoot: string): ReindexResult {
	const result: ReindexResult = { runs: 0, spans: 0, skipped: [] };
	transaction(db, () => {
		db.exec("DELETE FROM spans; DELETE FROM runs;");
		if (!existsSync(runsRoot)) return;
		for (const name of readdirSync(runsRoot).sort()) indexDir(db, join(runsRoot, name), result);
	});
	return result;
}

function indexDir(db: Db, dir: string, result: ReindexResult): void {
	try {
		if (!statSync(dir).isDirectory()) return;
	} catch {
		return;
	}
	const counts = indexRun(db, dir);
	if (!counts) {
		result.skipped.push(dir);
		return;
	}
	result.runs++;
	result.spans += counts.spans;
	const subagents = join(dir, "subagents");
	if (existsSync(subagents)) {
		for (const name of readdirSync(subagents).sort()) indexDir(db, join(subagents, name), result);
	}
}

/** Inserts one directory's run and spans atomically; returns null (leaving the index untouched) when it cannot be indexed. */
function indexRun(db: Db, dir: string): { spans: number } | null {
	db.exec("SAVEPOINT index_dir");
	try {
		const run = readRunJson(dir) as RunJson | null;
		if (typeof run !== "object" || run === null || Array.isArray(run)) throw new Error("run.json is not an object");
		const stillRunning = run.status === "running";
		insertRun(db, {
			id: run.id,
			parentRunId: run.parentRunId,
			rootRunId: run.rootRunId,
			dirPath: dir,
			instruction: run.instruction,
			skill: run.skill,
			status: stillRunning ? "aborted" : run.status,
			configSnapshotHash: run.configSnapshotHash,
			artifactSetId: run.artifactSetId,
			modelFinal: run.model ? `${run.model.provider}/${run.model.id}` : null,
			tierFinal: run.model?.role ?? null,
			escalations: 0,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			costUsd: run.costUsd,
			costUnknown: run.costUnknown,
			tokensIn: run.tokensIn,
			tokensOut: run.tokensOut,
			pid: null,
			error: stillRunning
				? { code: "INTERNAL", message: "The run was still marked running when the index was rebuilt", retryable: false }
				: run.error,
		});
		if (run.humanVerdict) restoreFeedback(db, run.id, run.humanVerdict);
		let spans = 0;
		for (const span of readTrajectory(dir)) {
			insertSpan(db, span);
			spans++;
		}
		db.exec("RELEASE index_dir");
		return { spans };
	} catch {
		db.exec("ROLLBACK TO index_dir; RELEASE index_dir");
		return null;
	}
}
