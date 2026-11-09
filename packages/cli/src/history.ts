import { parseArgs } from "node:util";
import { recentPrompts } from "@nexo/core";
import { ensureNexoDirs, resolveNexoPaths } from "@nexo/store";
import { escapeControl, oneLine } from "@nexo/tui";
import { type CliIO, type CliOptions, usageError } from "./common.ts";

/** Prompt text is cut to one line of this many characters, as `nexo sessions` does for titles. */
const TEXT_WIDTH = 80;
/** Fewer than the 100 the TUI loads: a listing is for reading, not recall. */
const DEFAULT_LIMIT = 20;

/** `nexo history [--limit n] [--all]`: prompts typed in interactive sessions (the up-arrow history), oldest first. */
export function historyCommand(args: string[], io: CliIO, options: CliOptions): number {
	const { values } = parseArgs({ args, options: { limit: { type: "string" }, all: { type: "boolean" } } });
	let limit = DEFAULT_LIMIT;
	// Same strict integer check and 1..1000 range as `nexo sessions --limit`, so both commands reject bad input alike.
	if (values.limit !== undefined) {
		limit = /^\d+$/.test(values.limit) ? Number(values.limit) : Number.NaN;
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw usageError("--limit must be an integer from 1 to 1000");
	}
	const paths = resolveNexoPaths(options.env ?? process.env);
	ensureNexoDirs(paths);
	const entries = recentPrompts(paths, { cwd: options.cwd ?? process.cwd(), limit, all: values.all ?? false });
	if (entries.length === 0) {
		io.stdout.write(values.all ? "No prompt history yet. Run `nexo` to start a session.\n" : "No prompt history in this project. Try `nexo history --all`.\n");
		return 0;
	}
	// escapeControl: a prompt may contain terminal escape sequences, which must not run when listed.
	for (const e of entries) {
		io.stdout.write(`${e.at.slice(0, 16).replace("T", " ")}  ${e.sessionId}  ${oneLine(escapeControl(e.text), TEXT_WIDTH)}\n`);
	}
	return 0;
}
