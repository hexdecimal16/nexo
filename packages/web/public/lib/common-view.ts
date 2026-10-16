import type { ApiErrorBody, Verdict } from "./api-types.ts";
import { html, type SafeHtml } from "./html.ts";

export function runLink(id: string): string {
	return `/run.html?id=${encodeURIComponent(id)}`;
}

/** The runs list filtered to one session's turns. */
export function sessionLink(sessionId: string): string {
	return `/?session=${encodeURIComponent(sessionId)}`;
}

const STATUS_GLYPH = new Map([
	["succeeded", "✓"],
	["ok", "✓"],
	["running", "◌"],
	["failed", "✕"],
	["error", "✕"],
	["aborted", "✕"],
	["budget_exceeded", "✕"],
]);

/** A run or span status badge. The class is `status-<status>` for plain lowercase names (style.css colours the known ones) and `status-other` for anything else. */
export function statusBadge(status: string): SafeHtml {
	const cls = /^[a-z_]{1,32}$/.test(status) ? status : "other";
	const glyph = STATUS_GLYPH.get(cls) ?? "·";
	return html`<span class="badge status-${cls}"><span class="glyph" aria-hidden="true">${glyph}</span> ${status.replace("_", " ")}</span>`;
}

export function verdictBadge(verdict: Verdict | null): SafeHtml {
	if (verdict === null) return html`<span class="badge verdict-none"><span class="glyph" aria-hidden="true">–</span> unreviewed</span>`;
	const glyph = verdict === "done" ? "✓" : "✕";
	return html`<span class="badge verdict-${verdict}"><span class="glyph" aria-hidden="true">${glyph}</span> ${verdict === "done" ? "done" : "not done"}</span>`;
}

/** The API error envelope as a message block (code, message, hint). */
export function renderError(error: ApiErrorBody): SafeHtml {
	return html`<div class="error" role="alert"><strong>${error.code}</strong> ${error.message}${error.hint ? html`<div class="hint">${error.hint}</div>` : ""}</div>`;
}

/** Spine state of a run row or card; style.css colours the left rail from it. */
export function stateClass(status: string): string {
	if (status === "succeeded" || status === "ok") return "state-ok";
	if (status === "running") return "state-running";
	if (["failed", "error", "aborted", "budget_exceeded"].includes(status)) return "state-bad";
	return "state-none";
}
