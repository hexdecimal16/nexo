import type { RunStatus, RunSummary } from "./api-types.ts";
import { runLink, statusBadge, verdictBadge } from "./common-view.ts";
import { durationMs, formatDuration, formatTime, formatUsd, truncate } from "./format.ts";
import { html, type SafeHtml } from "./html.ts";

export type RunsTab = "all" | "review";

export interface RunFilters {
	tab: RunsTab;
	status: string;
	skill: string;
	since: string;
}

export const PAGE_SIZE = 50;

/** API path for one page of the runs list. The review tab asks for finished runs without feedback. */
export function runsQuery(filters: RunFilters, cursor: string | null, limit: number = PAGE_SIZE): string {
	const params = new URLSearchParams();
	if (filters.tab === "review") params.set("reviewed", "false");
	if (filters.status) params.set("status", filters.status);
	if (filters.skill.trim()) params.set("skill", filters.skill.trim());
	if (filters.since) params.set("since", filters.since);
	params.set("limit", String(limit));
	if (cursor) params.set("cursor", cursor);
	return `/api/runs?${params.toString()}`;
}

export function renderRunRows(runs: RunSummary[], nowMs: number): SafeHtml {
	return html`${runs.map(
		(run) => html`<tr>
		<td class="mono">${formatTime(run.startedAt)}</td>
		<td><a href="${runLink(run.id)}">${truncate(run.instruction.split("\n")[0] ?? "", 120)}</a>${run.childCount ? html` <span class="muted">· ${run.childCount} subagent${run.childCount === 1 ? "" : "s"}</span>` : ""}</td>
		<td>${run.skill ?? html`<span class="muted">–</span>`}</td>
		<td>${statusBadge(run.status)}</td>
		<td class="mono">${run.modelFinal ?? "–"}</td>
		<td class="num">${formatDuration(durationMs(run.startedAt, run.endedAt, nowMs))}</td>
		<td class="num${run.costUnknown ? " warn" : ""}">${formatUsd(run.costUsd, run.costUnknown)}</td>
		<td>${verdictBadge(run.verdict)}</td>
	</tr>`,
	)}`;
}

/** `<option>`s for the status filter, from the statuses in `/api/meta`; the first option means any status. */
export function renderStatusOptions(statuses: readonly RunStatus[], selected: string): SafeHtml {
	return html`<option value="">any</option>${statuses.map((s) => html`<option value="${s}"${s === selected ? html` selected` : ""}>${s.replace("_", " ")}</option>`)}`;
}

export function renderEmptyRuns(tab: RunsTab): SafeHtml {
	return html`<tr><td colspan="8" class="empty">${tab === "review" ? "Nothing to review. Finished runs without a verdict appear here." : "No runs match these filters."}</td></tr>`;
}
