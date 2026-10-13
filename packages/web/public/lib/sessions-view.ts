import type { SessionListItem } from "./api-types.ts";
import { runLink, sessionLink, statusBadge } from "./common-view.ts";
import { formatTime, formatUsd, truncate } from "./format.ts";
import { html, type SafeHtml } from "./html.ts";

/** One table row per session; the title opens the session's turns, and unreviewed turns are highlighted. */
export function renderSessionRows(sessions: readonly SessionListItem[]): SafeHtml {
	if (sessions.length === 0) {
		return html`<tr><td colspan="7" class="empty">No sessions yet. Start one with <code>nexo</code>.</td></tr>`;
	}
	return html`${sessions.map(
		(s) => html`<tr>
		<td><a href="${sessionLink(s.id)}">${truncate(s.title, 80) || html`<span class="muted">(untitled)</span>`}</a></td>
		<td>${statusBadge(s.status)}</td>
		<td class="num">${s.turns}</td>
		<td class="num">${formatUsd(s.costUsd)} of $${s.budgetUsd.toFixed(2)}</td>
		<td class="num${s.unreviewedTurns > 0 ? " warn" : ""}">${s.unreviewedTurns}</td>
		<td>${s.lastTurn ? html`<a href="${runLink(s.lastTurn.runId)}">${statusBadge(s.lastTurn.status)}</a> <span class="muted mono">${formatTime(s.lastTurn.startedAt)}</span>` : html`<span class="muted">–</span>`}</td>
		<td class="mono">${formatTime(s.updatedAt)}</td>
	</tr>`,
	)}`;
}
