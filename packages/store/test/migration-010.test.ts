import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/index.ts";

const DIR = fileURLToPath(new URL("../src/migrations/", import.meta.url));

/** A database with migrations 001–009 applied, as an existing install has it. */
function dbAtVersion9(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
	for (const file of readdirSync(DIR).filter((f) => /^00[1-9]_.*\.sql$/.test(f)).sort()) {
		const sql = readFileSync(DIR + file, "utf8");
		if (sql.startsWith("-- nexo:foreign-keys-off")) db.exec("PRAGMA foreign_keys = OFF");
		db.exec(sql);
		db.exec("PRAGMA foreign_keys = ON");
		db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(Number(file.slice(0, 3)), file, "2026-10-01T00:00:00.000Z");
	}
	return db;
}

const MEMORY = "INSERT INTO memories (id, scope, type, content, importance, source, created_at) VALUES (?, ?, 'fact', ?, 0.5, 'ace', '2026-10-01T00:00:00.000Z')";

describe("migration 010", () => {
	it("accepts project scopes and keeps memories, their embeddings and the full-text index", () => {
		const db = dbAtVersion9();
		db.prepare(MEMORY).run("M1", "user", "likes tabs");
		db.prepare(MEMORY).run("M2", "skill:ci-fix", "run lint first");
		db.prepare("INSERT INTO memory_embeddings (memory_id, model, dim, vector, created_at) VALUES ('M1', 'x/y', 1, x'00000000', '2026-10-01T00:00:00.000Z')").run();
		expect(() => db.prepare(MEMORY).run("M0", "project:0123456789ab", "nope")).toThrow(/CHECK/);

		expect(migrate(db)).toEqual([10]);

		db.prepare(MEMORY).run("M3", "project:0123456789ab", "uses vitest");
		expect(() => db.prepare(MEMORY).run("M4", "team", "bad scope")).toThrow(/CHECK/);
		expect(db.prepare("SELECT id, scope FROM memories ORDER BY id").all()).toEqual([
			{ id: "M1", scope: "user" },
			{ id: "M2", scope: "skill:ci-fix" },
			{ id: "M3", scope: "project:0123456789ab" },
		]);
		// The FTS rowids still point at the right rows, old and new.
		const hit = (q: string) => db.prepare("SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ?").all(q);
		expect(hit("tabs")).toEqual([{ id: "M1" }]);
		expect(hit("vitest")).toEqual([{ id: "M3" }]);
		expect(db.prepare("SELECT memory_id FROM memory_embeddings").all()).toEqual([{ memory_id: "M1" }]);
		expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	});
});
