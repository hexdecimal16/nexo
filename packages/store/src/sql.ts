import type { SQLInputValue } from "node:sqlite";
import type { Db } from "./db.ts";

export type Encoder = (key: string, value: unknown) => SQLInputValue;

/** INSERT (or INSERT OR REPLACE) of a row whose keys map to columns through `columns`. */
export function insertRow(
	db: Db,
	table: string,
	columns: Record<string, string>,
	row: Record<string, unknown>,
	encode: Encoder,
	replace = false,
): void {
	const keys = Object.keys(columns);
	const sql = `INSERT ${replace ? "OR REPLACE " : ""}INTO ${table} (${keys.map((k) => columns[k]).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
	db.prepare(sql).run(...keys.map((k) => encode(k, row[k])));
}

export function updateById(
	db: Db,
	table: string,
	columns: Record<string, string>,
	id: string,
	patch: Record<string, unknown>,
	encode: Encoder,
): void {
	const keys = Object.keys(patch).filter((k) => k in columns && patch[k] !== undefined);
	if (keys.length === 0) return;
	const sql = `UPDATE ${table} SET ${keys.map((k) => `${columns[k]} = ?`).join(", ")} WHERE id = ?`;
	db.prepare(sql).run(...keys.map((k) => encode(k, patch[k])), id);
}
