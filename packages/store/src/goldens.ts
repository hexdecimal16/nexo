import type { Redactor } from "@nexo/telemetry";
import { NexoError } from "@nexo/telemetry";
import { type Db, transaction } from "./db.ts";
import { newId } from "./ids.ts";
import { type EvalCaseRow, type GoldenSource, getEvalCase } from "./judge-calibration.ts";

/** Longest eval-case text, in characters (also `MAX_EVAL_INPUT_CHARS` in eval-cases.ts). */
const MAX_GOLDEN_CHARS = 20_000;

export interface GoldenRow {
	id: string;
	caseId: string;
	expected: string;
	source: GoldenSource;
	/** The run whose output this is: the reviewed run, or the climb's baseline rollout. */
	sourceRunId: string | null;
	/** The climb that raised it; null otherwise. */
	optimRunId: string | null;
	createdAt: string;
}

function decode(row: Record<string, unknown>): GoldenRow {
	return {
		id: String(row.id),
		caseId: String(row.case_id),
		expected: String(row.expected),
		source: row.source as GoldenSource,
		sourceRunId: (row.source_run_id as string | null) ?? null,
		optimRunId: (row.optim_run_id as string | null) ?? null,
		createdAt: String(row.created_at),
	};
}

function requireCase(db: Db, caseId: string): EvalCaseRow {
	const c = getEvalCase(db, caseId);
	if (!c) throw new NexoError({ code: "NOT_FOUND", message: `Eval case ${caseId} does not exist`, context: { caseId }, hint: "List cases with `nexo eval list --target <target>`" });
	return c;
}

/** Appends one value to a case's golden history. Callers write `eval_cases.expected` in the same transaction. */
export function recordGolden(db: Db, input: { caseId: string; expected: string; source: GoldenSource; sourceRunId?: string | null; optimRunId?: string | null; nowIso: string }): GoldenRow {
	const row: GoldenRow = { id: newId(), caseId: input.caseId, expected: input.expected, source: input.source, sourceRunId: input.sourceRunId ?? null, optimRunId: input.optimRunId ?? null, createdAt: input.nowIso };
	db.prepare("INSERT INTO eval_case_goldens (id, case_id, expected, source, source_run_id, optim_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(row.id, row.caseId, row.expected, row.source, row.sourceRunId, row.optimRunId, row.createdAt);
	return row;
}

/** A case's golden history, oldest first. */
export function listGoldens(db: Db, caseId: string): GoldenRow[] {
	return db.prepare("SELECT * FROM eval_case_goldens WHERE case_id = ? ORDER BY created_at, rowid").all(caseId).map(decode);
}

/** A climb's baseline beat the golden: it becomes the golden (redacted, clipped). Throws NOT_FOUND. */
export function raiseGolden(db: Db, input: { caseId: string; expected: string; sourceRunId: string | null; optimRunId: string; redact: Redactor; nowIso: string }): EvalCaseRow {
	return transaction(db, () => {
		requireCase(db, input.caseId);
		const text = input.redact(input.expected);
		const expected = text.length > MAX_GOLDEN_CHARS ? `${text.slice(0, MAX_GOLDEN_CHARS - 1)}…` : text;
		db.prepare("UPDATE eval_cases SET expected = ?, golden_source = 'climb' WHERE id = ?").run(expected, input.caseId);
		recordGolden(db, { caseId: input.caseId, expected, source: "climb", sourceRunId: input.sourceRunId, optimRunId: input.optimRunId, nowIso: input.nowIso });
		return requireCase(db, input.caseId);
	});
}

/**
 * Undoes climb raises: the golden becomes the newest history value whose source is not `climb` (the last
 * human-approved golden), or none. Throws NOT_FOUND, or CONFLICT when the current golden is not from climb.
 */
export function revertGolden(db: Db, caseId: string, nowIso: string): EvalCaseRow {
	return transaction(db, () => {
		const c = requireCase(db, caseId);
		if (c.goldenSource !== "climb") {
			throw new NexoError({ code: "CONFLICT", message: `The golden of eval case ${caseId} is not from climb, so there is nothing to revert`, context: { caseId, goldenSource: c.goldenSource } });
		}
		const human = listGoldens(db, caseId).filter((g) => g.source !== "climb").at(-1);
		db.prepare("UPDATE eval_cases SET expected = ?, golden_source = ? WHERE id = ?").run(human?.expected ?? null, human?.source ?? null, caseId);
		if (human) recordGolden(db, { caseId, expected: human.expected, source: human.source, sourceRunId: human.sourceRunId, nowIso });
		return requireCase(db, caseId);
	});
}
