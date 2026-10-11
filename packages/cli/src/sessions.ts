import { parseArgs } from "node:util";
import { listSessions } from "@nexo/core";
import { ensureNexoDirs, openDb, resolveNexoPaths } from "@nexo/store";
import { escapeControl, oneLine } from "@nexo/tui";
import { type CliIO, type CliOptions, usageError } from "./common.ts";

const TITLE_WIDTH = 50;

/** `nexo sessions [--limit n]`: id, title, turns, cost and updated time (UTC), newest first. */
export function sessionsCommand(args: string[], io: CliIO, options: CliOptions): number {
	const { values } = parseArgs({ args, options: { limit: { type: "string" } } });
	let limit: number | undefined;
	if (values.limit !== undefined) {
		limit = /^\d+$/.test(values.limit) ? Number(values.limit) : Number.NaN;
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw usageError("--limit must be an integer from 1 to 1000");
	}
	const paths = resolveNexoPaths(options.env ?? process.env);
	ensureNexoDirs(paths);
	const rows = listSessions(openDb(paths.db), { limit });
	if (rows.length === 0) {
		io.stdout.write("No sessions yet. Run `nexo` to start one.\n");
		return 0;
	}
	const cells = rows.map((r) => [r.id, oneLine(escapeControl(r.title), TITLE_WIDTH) || "(untitled)", String(r.turns), `$${r.costUsd.toFixed(4)}`, r.updatedAt.slice(0, 16).replace("T", " ")]);
	const head = ["ID", "TITLE", "TURNS", "COST", "UPDATED"];
	const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] as string).length)));
	const right = new Set([2, 3]);
	const line = (c: string[]): string =>
		c
			.map((cell, i) => (i === c.length - 1 ? cell : right.has(i) ? cell.padStart(widths[i] as number) : cell.padEnd(widths[i] as number)))
			.join("  ");
	io.stdout.write(`${line(head)}\n`);
	for (const c of cells) io.stdout.write(`${line(c)}\n`);
	return 0;
}
