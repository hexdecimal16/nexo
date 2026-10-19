import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { NexoError } from "@nexo/telemetry";

export type Db = DatabaseSync;

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** A migration whose first line is this marker rebuilds a table that others reference: it runs with foreign keys off and is checked with foreign_key_check before it commits. */
const FK_OFF_MARKER = "-- nexo:foreign-keys-off";

export function openDb(path: string): Db {
	try {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		const db = new DatabaseSync(path);
		try {
			db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
			migrate(db);
		} catch (error) {
			db.close();
			throw error;
		}
		return db;
	} catch (cause) {
		if (cause instanceof NexoError) throw cause;
		throw new NexoError({
			code: "STORE_IO",
			message: `Cannot open database at ${path}`,
			hint: "Check that NEXO_HOME points to a writable directory",
			context: { path },
			cause,
		});
	}
}

/** Applies pending `NNN_name.sql` migrations in order, each in its own transaction. Returns applied versions. */
export function migrate(db: Db): number[] {
	db.exec(
		"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
	);
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => /^\d{3}_.+\.sql$/.test(f))
		.sort();
	const applied: number[] = [];
	for (const file of files) {
		const version = Number(file.slice(0, 3));
		const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
		const fkOff = sql.startsWith(FK_OFF_MARKER);
		// PRAGMA foreign_keys is a no-op inside a transaction, so it is switched outside it.
		if (fkOff) db.exec("PRAGMA foreign_keys = OFF");
		let ran: boolean;
		try {
		ran = transaction(db, () => {
			const current = Number(db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get()?.v ?? 0);
			if (version <= current) return false;
			db.exec(sql);
			if (fkOff) {
				const broken = db.prepare("PRAGMA foreign_key_check").all();
				if (broken.length > 0) throw new Error(`Migration ${file} left ${broken.length} foreign key violations`);
			}
			db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
				version,
				file,
				new Date().toISOString(),
			);
			return true;
		});
		} finally {
			if (fkOff) db.exec("PRAGMA foreign_keys = ON");
		}
		if (ran) applied.push(version);
	}
	return applied;
}

let savepoints = 0;

/** Runs `fn` in a transaction (BEGIN IMMEDIATE); inside an open transaction it uses a savepoint, so calls nest. */
export function transaction<T>(db: Db, fn: () => T): T {
	if (db.isTransaction) {
		const name = `nexo_sp_${++savepoints}`;
		db.exec(`SAVEPOINT ${name}`);
		try {
			const result = fn();
			db.exec(`RELEASE ${name}`);
			return result;
		} catch (error) {
			db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
			throw error;
		}
	}
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
