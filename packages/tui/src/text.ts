import type { ErrorPayload } from "@nexo/telemetry";

/** Bidi overrides and isolates, and zero-width characters: invisible, but they reorder or hide text. */
const INVISIBLE = "\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff";
const CONTROL = new RegExp(`[\u0000-\u001f\u007f-\u009f${INVISIBLE}]`, "g");
const CONTROL_EXCEPT_LINES = new RegExp(`[\u0000-\u0008\u000b-\u001f\u007f-\u009f${INVISIBLE}]`, "g");

function visible(c: string): string {
	const code = c.charCodeAt(0);
	return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
}

/** Replaces control characters (ANSI escapes, carriage returns, newlines) and bidi/zero-width characters with visible text. */
export function escapeControl(text: string): string {
	return text.replace(CONTROL, visible);
}

/** Like `escapeControl`, but keeps newlines and tabs (for multi-line agent text). */
export function escapeControlKeepLines(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(CONTROL_EXCEPT_LINES, visible);
}

/** Collapses text to one line and cuts it to `max` characters. */
export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

const SUBJECT_KEY: Record<string, string> = { bash: "command", read: "path", write: "path", edit: "path", web_fetch: "url", load_skill: "name" };

/** `tool(args)` summary: the tool's subject argument when it has one, otherwise compact JSON; control-escaped. */
export function toolSummary(toolName: string, args: unknown, max = 80): string {
	let subject: string;
	const key = SUBJECT_KEY[toolName];
	const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : null;
	if (key && record && typeof record[key] === "string") subject = record[key] as string;
	else if (toolName === "spawn" && record && Array.isArray(record.tasks)) {
		const ids = record.tasks.map((t) => (t && typeof t === "object" && typeof (t as { id?: unknown }).id === "string" ? (t as { id: string }).id : "?"));
		subject = `${ids.length} task${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`;
	} else {
		try {
			subject = JSON.stringify(args ?? {}) ?? "";
		} catch {
			subject = "…";
		}
	}
	return `${escapeControl(toolName)}(${escapeControl(oneLine(subject, max))})`;
}

/** The non-empty lines of a tool result, control-escaped. */
export function resultLines(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter((l) => l.length > 0)
		.map((l) => escapeControl(l.replace(/\t/g, "  ")));
}

/** The first `maxLines` non-empty lines of a tool result, control-escaped. */
export function previewLines(preview: string, maxLines = 3): string[] {
	const lines = resultLines(preview);
	const out = lines.slice(0, maxLines);
	if (lines.length > maxLines) out.push(`… ${lines.length - maxLines} more line${lines.length - maxLines === 1 ? "" : "s"} (ctrl+o to expand)`);
	return out;
}

export function usd(value: number): string {
	return `$${value.toFixed(2)}`;
}

export function duration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `error [CODE] message — hint`, control-escaped. */
export function formatError(error: Pick<ErrorPayload, "code" | "message" | "hint">): string {
	const hint = error.hint ? ` — ${error.hint}` : "";
	return escapeControl(`error [${error.code}] ${error.message}${hint}`);
}
