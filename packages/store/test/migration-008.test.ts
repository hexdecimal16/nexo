import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getEvalCase, listActiveEvalCases, listEvalCases, migrate } from "../src/index.ts";

const DIR = fileURLToPath(new URL("../src/migrations/", import.meta.url));

/** A database with migrations 001–007 applied, as an existing install has it. */
function dbAtVersion7(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
	for (const file of readdirSync(DIR).filter((f) => /^00[1-7]_.*\.sql$/.test(f)).sort()) {
		db.exec(readFileSync(DIR + file, "utf8"));
		db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(Number(file.slice(0, 3)), file, "2026-10-01T00:00:00.000Z");
	}
	return db;
}

describe("migration 008", () => {
	it("keeps every eval case, backfills golden_source and the golden history, and defaults optim_runs to gepa", () => {
		const db = dbAtVersion7();
		const insert = db.prepare("INSERT INTO eval_cases (id, target, source_run_id, input, expected, reference_feedback, scorer_spec_json, split, created_at, skill, origin) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)");
		insert.run("C1", "skill:ci-fix", "R1", "fix ci", "done output", "good", "pareto", "2026-10-01T00:00:00.000Z", "ci-fix", "run");
		insert.run("C2", "skill:ci-fix", null, "fix lint", null, null, "holdout", "2026-10-02T00:00:00.000Z", "ci-fix", "manual");
		insert.run("C3", "skill:ci-fix", null, "fix tests", "manual golden", null, "feedback", "2026-10-03T00:00:00.000Z", "ci-fix", "manual");
		insert.run("C4", "judge_rubric", "R4", "judge me", "done", "", "pareto", "2026-10-04T00:00:00.000Z", null, "run");
		migrate(db);
		const cases = listEvalCases(db, "skill:ci-fix");
		expect(cases.map((c) => [c.id, c.status, c.goldenSource, c.origin, c.split])).toEqual([
			["C1", "active", "run", "run", "pareto"],
			["C2", "active", null, "manual", "holdout"],
			["C3", "active", "manual", "manual", "feedback"],
		]);
		expect(getEvalCase(db, "C4")).toMatchObject({ goldenSource: null, status: "active" });
		const history = db.prepare("SELECT case_id, expected, source FROM eval_case_goldens ORDER BY case_id").all();
		expect(history).toEqual([
			{ case_id: "C1", expected: "done output", source: "run" },
			{ case_id: "C3", expected: "manual golden", source: "manual" },
		]);
		expect(() => insert.run("C5", "skill:ci-fix", "R1", "dup", null, null, "pareto", "2026-10-05T00:00:00.000Z", null, "run")).toThrow(/UNIQUE/);
		expect(() => db.prepare("UPDATE eval_cases SET origin = 'bogus' WHERE id = 'C1'").run()).toThrow(/CHECK/);
		expect(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('optim_runs') WHERE name IN ('mode','case_id','climb_outcome')").get()).toEqual({ n: 3 });
	});

	it("lists only active cases for optimizations and refuses unknown stored values", () => {
		const db = dbAtVersion7();
		migrate(db);
		const insert = db.prepare("INSERT INTO eval_cases (id, target, input, split, created_at, origin, status) VALUES (?, 'skill:x', ?, 'pareto', ?, ?, ?)");
		insert.run("A", "a", "2026-10-01T00:00:00.000Z", "manual", "active");
		insert.run("P", "p", "2026-10-02T00:00:00.000Z", "mined", "proposed");
		insert.run("D", "d", "2026-10-03T00:00:00.000Z", "mined", "dismissed");
		expect(listActiveEvalCases(db, "skill:x").map((c) => c.id)).toEqual(["A"]);
		expect(listEvalCases(db, "skill:x").map((c) => c.status)).toEqual(["active", "proposed", "dismissed"]);
	});
});
