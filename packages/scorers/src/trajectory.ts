import type { SpanSummary } from "./types.ts";

/** Longest trajectory summary shown to the judge. */
export const MAX_TRAJECTORY_CHARS = 6000;

/** The compact trajectory the judge sees: each tool call with its outcome, then the files changed and the error count. */
export function renderTrajectory(steps: readonly SpanSummary[], maxChars: number = MAX_TRAJECTORY_CHARS): string {
	const tools = steps.filter((s) => s.kind === "tool_call" || s.kind === "skill_load" || s.kind === "subagent");
	const errors = steps.filter((s) => s.status === "error");
	const files = [...new Set(steps.flatMap((s) => (s.file ? [s.file] : [])))];
	const lines = tools.map((s) => `- ${s.status === "error" ? "✗" : "✓"} ${s.name} ${s.detail}${s.error ? ` — error: ${s.error}` : ""}`);
	const footer = [`Files changed: ${files.length ? files.join(", ") : "none"}`, `Failed steps: ${errors.length}`];
	let body = lines.join("\n");
	const budget = maxChars - footer.join("\n").length - 64;
	if (body.length > budget) {
		const keep = Math.max(0, Math.floor(budget / 2));
		body = `${body.slice(0, keep)}\n… [${body.length - 2 * keep} characters of steps omitted] …\n${body.slice(-keep)}`;
	}
	return `Tool calls (${tools.length}):\n${body || "(none)"}\n${footer.join("\n")}`;
}
