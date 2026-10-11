import type { EscalationSignal } from "@nexo/router";
import type { ScoreRow } from "@nexo/store";

/** Longest rationale quoted per failed check in the continuation prompt. */
const RATIONALE_CHARS = 1500;

/** The message that starts an S2 continuation turn: why the answer was rejected and what to do next. */
export function continuationPrompt(signals: readonly EscalationSignal[], scores: readonly ScoreRow[]): string {
	const failed = scores.filter((s) => s.status === "ok" && s.passed === false);
	const lines = [
		"[nexo] Your previous answer did not pass the end-of-run checks, so you continue on a stronger model.",
		"",
		"Why:",
		...signals.map((s) => `- ${s.trigger}: ${s.reason}`),
	];
	if (failed.length > 0) {
		lines.push("", "Failed checks:");
		for (const s of failed) {
			const value = s.value === null ? "" : ` (score ${s.value.toFixed(2)})`;
			const rationale = s.rationale.length > RATIONALE_CHARS ? `…${s.rationale.slice(-RATIONALE_CHARS)}` : s.rationale;
			lines.push(`- ${s.scorerName} [${s.scorerType}]${value}:`, ...rationale.split("\n").map((l) => `  ${l}`));
		}
	}
	lines.push("", "Fix the problems, then give your complete final answer again.");
	return lines.join("\n");
}
