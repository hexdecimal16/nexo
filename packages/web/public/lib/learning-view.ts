import type { LearnJobsResponse, Memory, PlaybookItem, PlaybookListResponse, PlaybookResponse } from "./api-types.ts";
import { runLink, statusBadge } from "./common-view.ts";
import { formatTime, truncate } from "./format.ts";
import { html, type SafeHtml } from "./html.ts";

export const MEMORY_SCOPES_HINT = "user, global or skill:<name>";

export const MEMORIES_PAGE_SIZE = 50;
export const JOBS_PAGE_SIZE = 20;

/** One page of `/api/memories` with the filter form's values (empty values left out); `cursor` asks for the page after a previous one. */
export function memoriesQuery(scope: string, type: string, all: boolean, cursor: string | null = null, limit: number = MEMORIES_PAGE_SIZE): string {
	const params = new URLSearchParams();
	if (scope.trim()) params.set("scope", scope.trim());
	if (type) params.set("type", type);
	if (all) params.set("all", "1");
	params.set("limit", String(limit));
	if (cursor) params.set("cursor", cursor);
	return `/api/memories?${params.toString()}`;
}

/** One page of `/api/learn/jobs`, newest first. */
export function jobsQuery(cursor: string | null, limit: number = JOBS_PAGE_SIZE): string {
	const params = new URLSearchParams({ limit: String(limit) });
	if (cursor) params.set("cursor", cursor);
	return `/api/learn/jobs?${params.toString()}`;
}

function sourceBadge(source: string): SafeHtml {
	const cls = /^[a-z]{1,16}$/.test(source) ? source : "other";
	return html`<span class="badge source-${cls}">${source}</span>`;
}

function memoryState(m: Memory): SafeHtml | string {
	if (m.retiredAt) return html`<span class="muted">retired ${formatTime(m.retiredAt)}</span>`;
	if (m.supersededBy) return html`<span class="muted">replaced</span>`;
	return "";
}

/** The memory table; live memories get a Retire button (`data-retire-memory`) and every row a History button. */
export function renderMemories(memories: readonly Memory[], readOnly: boolean): SafeHtml {
	if (memories.length === 0) return html`<p class="muted">No memories match. Runs add them as they are reviewed and learned from; <code>nexo memory add</code> adds one by hand.</p>`;
	return html`<table class="runs memories">
	<thead><tr><th>Scope</th><th>Type</th><th>Source</th><th class="num">Importance</th><th>Memory</th><th>Created (UTC)</th><th>Last used</th><th></th></tr></thead>
	<tbody>${memories.map(
		(m) => html`<tr>
		<td class="mono">${m.scope}</td><td>${m.type}</td><td>${sourceBadge(m.source)}</td><td class="num">${m.importance.toFixed(2)}</td>
		<td>${m.content}${m.sourceRunId ? html` <a class="muted" href="${runLink(m.sourceRunId)}">run</a>` : ""} ${memoryState(m)}</td>
		<td class="mono">${formatTime(m.createdAt)}</td><td class="mono">${formatTime(m.lastUsedAt)}</td>
		<td class="actions"><button type="button" data-memory-history="${m.id}">History</button>${!readOnly && !m.retiredAt && !m.supersededBy ? html` <button type="button" class="danger" data-retire-memory="${m.id}">Retire</button>` : ""}</td>
	</tr>`,
	)}</tbody>
</table>`;
}

/** The replaced versions of a memory, newest first, under a heading that says which memory they belong to. */
export function renderMemoryHistory(memory: Memory, history: readonly Memory[]): SafeHtml {
	const heading = html`<h3>History of “${truncate(memory.content, 80)}”</h3>`;
	if (history.length === 0) return html`${heading}<p class="muted">This memory has not replaced an earlier one.</p>`;
	return html`${heading}<ol class="history">${history.map((m) => html`<li><span class="mono">${formatTime(m.createdAt)}</span> ${sourceBadge(m.source)} ${m.content}</li>`)}</ol>`;
}

/** Links to each skill's playbook (`data-playbook`). */
export function renderPlaybookList(data: PlaybookListResponse): SafeHtml {
	if (data.playbooks.length === 0) return html`<p class="muted">No playbook yet. The curator adds items after runs that used a skill; <code>nexo playbook add</code> adds a human one.</p>`;
	return html`<ul class="playbook-list">${data.playbooks.map(
		(p) => html`<li><button type="button" class="link" data-playbook="${p.skill}">${p.skill}</button> <span class="muted">${p.activeItems} item${p.activeItems === 1 ? "" : "s"}${p.version === null ? "" : ` · v${p.version} (${p.origin ?? "?"})`}</span></li>`,
	)}</ul>`;
}

function itemHistory(item: PlaybookItem): SafeHtml {
	return html`<details><summary>history (${item.history.length})</summary><ol class="history">${item.history.map(
		(h) => html`<li><span class="mono">${formatTime(h.createdAt)}</span> ${h.action} by ${h.actor}${h.content ? html`: ${truncate(h.content, 200)}` : ""}${h.runId ? html` <a class="muted" href="${runLink(h.runId)}">run</a>` : ""}</li>`,
	)}</ol></details>`;
}

/** One skill's playbook: items with source, helpful/harmful counters, history and a Retire button (`data-retire-item`), then the versions. */
export function renderPlaybook(data: PlaybookResponse, readOnly: boolean): SafeHtml {
	return html`<h3>${data.skill}</h3>
${data.items.length === 0
	? html`<p class="muted">No active items.</p>`
	: html`<table class="runs playbook">
	<thead><tr><th>Key</th><th>Source</th><th class="num">Helpful</th><th class="num">Harmful</th><th>Item</th><th></th></tr></thead>
	<tbody>${data.items.map(
		(i) => html`<tr${i.status === "retired" ? html` class="retired"` : ""}>
		<td class="mono">${i.key}</td><td>${sourceBadge(i.source)}</td><td class="num">${i.helpful}</td><td class="num">${i.harmful}</td>
		<td>${i.content}${i.status === "retired" ? html` <span class="muted">retired</span>` : ""}${itemHistory(i)}</td>
		<td class="actions">${!readOnly && i.status === "active" ? html`<button type="button" class="danger" data-retire-item="${i.key}" data-skill="${data.skill}">Retire</button>` : ""}</td>
	</tr>`,
	)}</tbody>
</table>`}
<p class="muted">Versions: ${data.versions.length === 0 ? "none yet" : data.versions.map((v, n) => html`${n > 0 ? ", " : ""}v${v.version} (${v.origin}${v.status === "active" ? ", active" : ""})`)}</p>`;
}

/** Job counts and the newest jobs with their errors. */
export function renderJobs(data: LearnJobsResponse): SafeHtml {
	const c = data.counts;
	return html`<div class="facts"><span>${c.pending} pending</span> · <span>${c.running} running</span> · <span>${c.succeeded} succeeded</span> · <span>${c.failed} failed</span></div>
${c.failed > 0 ? html`<p class="muted">Failed jobs with attempts left run again with <code>nexo learn --retry</code>.</p>` : ""}
${data.jobs.length === 0
	? html`<p class="muted">No learn jobs yet.</p>`
	: html`<table class="runs">
	<thead><tr><th>Updated (UTC)</th><th>Run</th><th>Trigger</th><th>Status</th><th class="num">Attempts</th><th>Error</th></tr></thead>
	<tbody>${data.jobs.map(
		(j) => html`<tr><td class="mono">${formatTime(j.updatedAt)}</td><td><a class="mono" href="${runLink(j.runId)}">${j.runId}</a></td><td>${j.trigger.replace("_", " ")}</td><td>${statusBadge(j.status)}</td><td class="num">${j.attempts}</td><td>${j.lastError ? html`<strong>${j.lastError.code}</strong> ${truncate(j.lastError.message, 200)}` : ""}</td></tr>`,
	)}</tbody>
</table>`}`;
}
