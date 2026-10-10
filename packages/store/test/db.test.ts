import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NexoError } from "@nexo/telemetry";
import { migrate, openDb, resolveNexoPaths } from "../src/index.ts";

describe("openDb", () => {
	it("creates all phase-1 tables and is idempotent", () => {
		const db = openDb(":memory:");
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all()
			.map((r) => r.name);
		expect(tables).toEqual(
			expect.arrayContaining(["artifact_sets", "artifacts", "budget_ledger", "runs", "schema_migrations", "spans"]),
		);
		expect(migrate(db)).toEqual([]);
	});

	it("throws STORE_IO when the path cannot be created", () => {
		const dir = mkdtempSync(join(tmpdir(), "nexo-db-"));
		const file = join(dir, "not-a-dir");
		writeFileSync(file, "x");
		try {
			openDb(join(file, "nexo.db"));
			expect.unreachable();
		} catch (err) {
			expect((err as NexoError).code).toBe("STORE_IO");
		}
	});
});

describe("resolveNexoPaths", () => {
	it("uses NEXO_HOME when set", () => {
		const p = resolveNexoPaths({ NEXO_HOME: "/tmp/nx" });
		expect(p).toMatchObject({ home: "/tmp/nx", db: "/tmp/nx/nexo.db", runs: "/tmp/nx/runs", config: "/tmp/nx/config.json" });
	});
});
