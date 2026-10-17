import type { RunStatus, RunSummary } from "./api-types.ts";
import { runLink, sessionLink, stateClass, statusBadge, verdictBadge } from "./common-view.ts";
import { durationMs, formatDuration, formatTime, formatUsd, truncate } from "./format.ts";
import { html, type SafeHtml } from "./html.ts";
import { type Page, pageParams } from "./pager.ts";
import { renderScoreCell } from "./score-view.ts";

export type RunsTab = "all" | "review";

export interface RunFilters {
	tab: RunsTab;
	status: string;
	skill: string;
	since: string;
	/** Session id from the page's `?session=` parameter; empty for all runs. */
	session: string;
	/** "true" (scored runs), "false" (finished runs without scores) or "" (all). */
	scored: string;
}

/** Filters from the page address: `?session=` picks a session's turns and `?tab=review` the review queue. */
export function readRunFilters(search: string): RunFilters {
	const params = new URLSearchParams(search);
	return { tab: params.get("tab") === "review" ? "review" : "all", status: "", skill: "", since: "", session: params.get("session") ?? "", scored: "" };
}

/** The search string that reopens the same tab and session, so a reload or the back button keeps them; empty for the default view. */
export function runsPageSearch(filters: RunFilters): string {
	const params = new URLSearchParams();
	if (filters.session) params.set("session", filters.session);
	if (filters.tab === "review") params.set("tab", "review");
	const query = params.toString();
	return query ? `?${query}` : "";
}

/**
 * API path for one page of the runs list. Without a session filter the list holds one-shot runs only; chat turns are
 * listed per session. The review tab asks for finished runs without feedback, chat turns included.
 */
export function runsQuery(filters: RunFilters, page: Page): string {
	const params = new URLSearchParams();
	if (filters.session) params.set("session", filters.session);
	else if (filters.tab !== "review") params.set("oneShot", "true");
	if (filters.tab === "review") params.set("reviewed", "false");
	if (filters.status) params.set("status", filters.status);
	if (filters.skill.trim()) params.set("skill", filters.skill.trim());
	if (filters.since) params.set("since", filters.since);
	if (filters.scored === "true" || filters.scored === "false") params.set("scored", filters.scored);
	return `/api/runs?${pageParams(page, params).toString()}`;
}

export function renderRunRows(runs: RunSummary[], nowMs: number): SafeHtml {
	return html`${runs.map(
		(run) => html`<tr class="${stateClass(run.status)}">
		<td class="mono">${formatTime(run.startedAt)}</td>
		<td><a href="${runLink(run.id)}">${truncate(run.instruction.split("\n")[0] ?? "", 120)}</a>${run.childCount ? html` <span class="muted">· ${run.childCount} subagent${run.childCount === 1 ? "" : "s"}</span>` : ""}</td>
		<td>${run.skill ?? html`<span class="muted">–</span>`}</td>
		<td>${statusBadge(run.status)}</td>
		<td class="mono">${run.modelFinal ?? "–"}</td>
		<td class="num">${formatDuration(durationMs(run.startedAt, run.endedAt, nowMs))}</td>
		<td class="num${run.costUnknown ? " warn" : ""}">${formatUsd(run.costUsd, run.costUnknown)}</td>
		<td>${renderScoreCell(run.score)}</td>
		<td>${verdictBadge(run.verdict)}</td>
	</tr>`,
	)}`;
}

/** The active session filter, with a link back to all runs; empty without one. */
export function renderSessionFilter(sessionId: string, title: string | null): SafeHtml {
	if (!sessionId) return html``;
	return html`<p class="session-filter">Turns of session <a class="mono" href="${sessionLink(sessionId)}">${title || sessionId}</a> <span class="muted mono">${sessionId}</span> · <a href="/">show all runs</a></p>`;
}

/** On the default view (all tabs, no session filter) chat turns are not listed; a muted line points to the Sessions page. */
export function renderRunsNote(filters: RunFilters): SafeHtml {
	if (filters.session || filters.tab === "review") return html``;
	return html`<p class="muted">Chat turns are listed per session on the <a href="/sessions.html">Sessions page</a>.</p>`;
}

/** `<option>`s for the status filter, from the statuses in `/api/meta`; the first option means any status. */
export function renderStatusOptions(statuses: readonly RunStatus[], selected: string): SafeHtml {
	return html`<option value="">any</option>${statuses.map((s) => html`<option value="${s}"${s === selected ? html` selected` : ""}>${s.replace("_", " ")}</option>`)}`;
}

export function renderEmptyRuns(tab: RunsTab): SafeHtml {
	return html`<tr><td colspan="9" class="empty">${tab === "review" ? "Nothing to review. Finished runs without a verdict appear here." : "No runs match these filters."}</td></tr>`;
}
