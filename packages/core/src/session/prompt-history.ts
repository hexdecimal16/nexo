import { appendPromptHistory, type NexoPaths, type PromptHistoryEntry, readPromptHistory } from "@nexo/store";
import type { Redactor } from "@nexo/telemetry";
import { projectRoots } from "./project-root.ts";

export interface RecentPromptsOptions {
	/** Directory whose project the history is for. */
	cwd: string;
	/** Most recent entries to return (default 100, the TUI editor's own history cap). */
	limit?: number;
	/** Every project's prompts instead of `cwd`'s project. */
	all?: boolean;
}

/**
 * Prompts typed in interactive sessions, oldest first: the TUI's up-arrow history, `nexo history` and
 * `Nexo.promptHistory()` all read it through here, scoped to the project like `/resume`.
 */
export function recentPrompts(paths: Pick<NexoPaths, "promptHistory">, options: RecentPromptsOptions): PromptHistoryEntry[] {
	return readPromptHistory(paths.promptHistory, { ...(options.limit !== undefined ? { limit: options.limit } : {}), ...(options.all ? {} : { underDir: projectRoots(options.cwd) }) });
}

/** Saves one typed prompt (redacted) to the history file. */
export function recordPrompt(paths: Pick<NexoPaths, "promptHistory">, redact: Redactor, entry: { text: string; cwd: string; sessionId: string }, now: Date = new Date()): void {
	appendPromptHistory(paths.promptHistory, { ...entry, at: now.toISOString() }, redact);
}
