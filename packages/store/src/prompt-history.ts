import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { NexoError, type Redactor } from "@nexo/telemetry";

/** One line of `~/.nexo/history.jsonl`: a prompt the user submitted in an interactive session. */
export interface PromptHistoryEntry {
	text: string;
	/** The session's directory (where nexo was started). */
	cwd: string;
	sessionId: string;
	/** ISO timestamp. */
	at: string;
}

/** Longest prompt kept; longer ones are cut. */
const MAX_ENTRY_CHARS = 20_000;
/** Default number of entries returned, the same as the TUI editor's own cap. */
export const PROMPT_HISTORY_LIMIT = 100;

/** Appends one prompt, trimmed and redacted. Blank prompts are skipped. STORE_IO when the file cannot be written. */
export function appendPromptHistory(file: string, entry: PromptHistoryEntry, redact: Redactor): void {
	const text = entry.text.trim();
	if (!text) return;
	// One append per entry. Several nexo processes may write at once; appends of one short line rarely interleave, and readPromptHistory skips any line that does get mangled.
	try {
		appendFileSync(file, `${JSON.stringify(redact({ ...entry, text: text.slice(0, MAX_ENTRY_CHARS) }))}\n`, { mode: 0o600 });
	} catch (cause) {
		throw new NexoError({ code: "STORE_IO", message: `Cannot append to ${file}`, retryable: true, cause });
	}
}

function under(cwd: string, dirs: readonly string[]): boolean {
	return dirs.some((raw) => {
		const dir = raw.replace(/\/+$/, "") || "/";
		return cwd === dir || cwd.startsWith(dir === "/" ? "/" : `${dir}/`);
	});
}

/**
 * The most recent prompts, oldest first, so adding them in order to an editor's history leaves the newest on top.
 * `underDir` keeps entries whose cwd is one of those directories or below them (a project's roots). Consecutive
 * duplicates are dropped, unparsable lines are skipped, and a missing file is an empty history.
 */
export function readPromptHistory(file: string, options: { limit?: number; underDir?: string | readonly string[] } = {}): PromptHistoryEntry[] {
	if (!existsSync(file)) return [];
	const dirs = options.underDir === undefined ? null : typeof options.underDir === "string" ? [options.underDir] : options.underDir;
	const limit = options.limit ?? PROMPT_HISTORY_LIMIT;
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (cause) {
		throw new NexoError({ code: "STORE_IO", message: `Cannot read ${file}`, cause });
	}
	const out: PromptHistoryEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let e: Partial<PromptHistoryEntry>;
		try {
			e = JSON.parse(line) as Partial<PromptHistoryEntry>;
		} catch {
			continue;
		}
		if (!e || typeof e.text !== "string" || typeof e.cwd !== "string" || !e.text.trim()) continue;
		// Project scope is checked before the duplicate test, so a repeat only counts against visible entries.
		if (dirs && !under(e.cwd, dirs)) continue;
		if (out.length > 0 && out[out.length - 1]?.text === e.text) continue;
		out.push({ text: e.text, cwd: e.cwd, sessionId: String(e.sessionId ?? ""), at: String(e.at ?? "") });
	}
	return limit > 0 ? out.slice(-limit) : [];
}
