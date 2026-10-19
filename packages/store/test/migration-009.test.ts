import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/index.ts";

const DIR = fileURLToPath(new URL("../src/migrations/", import.meta.url));

/** A database with migrations 001–008 applied, as an existing install has it. */
function dbAtVersion8(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
	for (const file of readdirSync(DIR).filter((f) => /^00[1-8]_.*\.sql$/.test(f)).sort()) {
		db.exec(readFileSync(DIR + file, "utf8"));
		db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(Number(file.slice(0, 3)), file, "2026-10-01T00:00:00.000Z");
	}
	return db;
}

const ARTIFACT = "INSERT INTO artifacts (id, kind, name, version, content, content_hash, parent_version_id, origin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

describe("migration 009", () => {
	it("keeps every artifact and its parent link, accepts tool_description and leaves foreign keys on", () => {
		const db = dbAtVersion8();
		db.prepare(ARTIFACT).run("A1", "skill", "ci-fix", 1, "v1", "h1", null, "manual", "retired", "2026-10-01T00:00:00.000Z");
		db.prepare(ARTIFACT).run("A2", "skill", "ci-fix", 2, "v2", "h2", "A1", "gepa", "active", "2026-10-02T00:00:00.000Z");
		expect(migrate(db)).toEqual([9]);
		expect(db.prepare("SELECT id, parent_version_id, status FROM artifacts ORDER BY id").all()).toEqual([
			{ id: "A1", parent_version_id: null, status: "retired" },
			{ id: "A2", parent_version_id: "A1", status: "active" },
		]);
		db.prepare(ARTIFACT).run("A3", "tool_description", "read", 1, "Read files", "h3", null, "manual", "active", "2026-10-03T00:00:00.000Z");
		expect(() => db.prepare(ARTIFACT).run("A4", "tool_description", "read", 2, "x", "h4", null, "manual", "active", "2026-10-04T00:00:00.000Z")).toThrow();
		expect(() => db.prepare(ARTIFACT).run("A5", "bogus", "read", 1, "x", "h5", null, "manual", "candidate", "2026-10-05T00:00:00.000Z")).toThrow();
		expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(db.prepare("SELECT \"table\" AS t FROM pragma_foreign_key_list('optim_candidates')").all()).toContainEqual({ t: "artifacts" });
	});

	it("is skipped on a database that already has it", () => {
		const db = dbAtVersion8();
		migrate(db);
		expect(migrate(db)).toEqual([]);
	});
});
