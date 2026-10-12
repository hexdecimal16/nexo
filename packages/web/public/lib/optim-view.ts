import type { CaseScore, DiffLine, OptimCandidate, OptimDetailResponse, OptimReport, OptimRunItem, PromotionState } from "./api-types.ts";
import { runLink, statusBadge } from "./common-view.ts";
import { formatTime, formatUsd, shortId, truncate } from "./format.ts";
import { html, type SafeHtml } from "./html.ts";

function quality(value: number | null | undefined): string {
	return value === null || value === undefined ? "–" : value.toFixed(3);
}

function version(v: number | null): string {
	return v === null ? "–" : `v${v}`;
}

/** The optimizations table; each row opens its detail (`data-optim`). */
export function renderOptimList(runs: readonly OptimRunItem[]): SafeHtml {
	if (runs.length === 0) return html`<p class="muted">No optimizations yet. Start one with <code>nexo optimize --target skill:&lt;name&gt;</code>.</p>`;
	return html`<table class="runs optim">
	<thead><tr><th>Started (UTC)</th><th>Target</th><th>Status</th><th>Stopped by</th><th class="num">Spent</th><th class="num">Rollouts</th><th>Holdout quality</th><th>Versions</th><th>Promotion</th></tr></thead>
	<tbody>${runs.map(
		(r) => html`<tr>
		<td class="mono"><button type="button" class="link" data-optim="${r.id}">${formatTime(r.createdAt)}</button></td>
		<td class="mono">${r.target}</td><td>${statusBadge(r.status)}</td><td>${r.stopReason ?? "–"}</td>
		<td class="num">${formatUsd(r.spentUsd)} of $${r.budgetUsd.toFixed(2)}</td><td class="num">${r.rollouts}</td>
		<td>${r.holdoutBefore === null ? "–" : `${quality(r.holdoutBefore)} → ${quality(r.holdoutAfter)}`}</td>
		<td>${version(r.baseVersion)} → ${version(r.bestVersion)}</td><td>${r.promotion ? r.promotion.replace("_", " ") : "–"}</td>
	</tr>`,
	)}</tbody>
</table>`;
}

function scoreCell(s: CaseScore): SafeHtml {
	return html`${quality(s.quality)} <span class="muted">${formatUsd(s.costUsd)}</span>`;
}

function renderHoldout(report: OptimReport): SafeHtml {
	const h = report.holdout;
	return html`<h3>Holdout report</h3>
<p>Quality ${quality(h.before.quality)} → <strong>${quality(h.after.quality)}</strong>, cost per case ${formatUsd(h.before.costUsd)} → ${formatUsd(h.after.costUsd)}.
${h.wins} win${h.wins === 1 ? "" : "s"}, ${h.losses} loss${h.losses === 1 ? "" : "es"}, ${h.ties} tie${h.ties === 1 ? "" : "s"}.
${report.improved ? "" : html`<span class="muted">No candidate beat the starting version.</span>`}</p>
<table class="runs holdout"><thead><tr><th>Case</th><th>Before</th><th>After</th><th>Outcome</th></tr></thead>
<tbody>${h.cases.map((c) => html`<tr><td>${truncate(c.input, 120)}</td><td>${scoreCell(c.before)}</td><td>${scoreCell(c.after)}</td><td><span class="badge outcome-${c.outcome}">${c.outcome}</span></td></tr>`)}</tbody></table>
<p class="muted">Stopped by ${report.stopReason} after ${report.iterations} iteration${report.iterations === 1 ? "" : "s"} and ${report.rollouts} rollouts (${formatUsd(report.spentUsd)}); ${report.merges} merge${report.merges === 1 ? "" : "s"}${report.mergeNote ? ` (${report.mergeNote})` : ""}.</p>`;
}

/** The base → best text diff, one line per row. */
export function renderDiff(diff: readonly DiffLine[]): SafeHtml {
	if (diff.every((d) => d.op === "same")) return html`<p class="muted">The best candidate is the starting text.</p>`;
	return html`<pre class="diff">${diff.map((d) => html`<span class="${d.op === "add" ? "diff-add" : d.op === "del" ? "diff-del" : ""}">${d.op === "add" ? "+ " : d.op === "del" ? "- " : "  "}${d.text}</span>`)}</pre>`;
}

function mean(scores: readonly CaseScore[]): string {
	return scores.length === 0 ? "–" : quality(scores.reduce((s, x) => s + x.quality, 0) / scores.length);
}

/** Every candidate with its parents, minibatch comparison and pareto mean (the lineage). */
export function renderLineage(candidates: readonly OptimCandidate[]): SafeHtml {
	return html`<table class="runs lineage">
	<thead><tr><th>Candidate</th><th>Origin</th><th>Parents</th><th class="num">Iteration</th><th>Minibatch</th><th>Pareto mean</th><th>Version</th><th>Accepted</th></tr></thead>
	<tbody>${candidates.map(
		(c) => html`<tr>
		<td class="mono">${shortId(c.id)}</td><td>${c.origin}${c.component ? ` · ${c.component}` : ""}</td>
		<td class="mono">${c.parentIds.map(shortId).join(", ") || "–"}</td><td class="num">${c.iteration}</td>
		<td>${c.minibatch ? `${mean(c.minibatch.parent)} → ${mean(c.minibatch.child)}` : "–"}</td>
		<td>${c.meanScore === null ? "–" : html`${quality(c.meanScore)} <span class="muted">${formatUsd(c.meanCostUsd ?? 0)}</span>`}</td>
		<td>${version(c.version)} ${c.artifactStatus ? html`<span class="muted">${c.artifactStatus}</span>` : ""}</td><td>${c.accepted ? "yes" : "no"}</td>
	</tr>`,
	)}</tbody>
</table>`;
}

function runsToReview(promotion: PromotionState): string[] {
	const list = promotion.error?.context?.runsToReview;
	return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
}

/** The evidence line and the Approve button (`data-approve`), or why approval is refused with the runs to review. */
export function renderApproval(data: OptimDetailResponse, readOnly: boolean): SafeHtml {
	const e = data.report?.evidence;
	const evidence = !e
		? ""
		: e.humanScored
			? html`<p>Evidence: human verdicts only (judge-rubric candidates are scored against your done / not done verdicts).</p>`
			: html`<p>Evidence: ${e.judgeOnly ? html`<strong>judge only</strong>` : "includes deterministic scorers"} · judge <span class="mono">${e.judgeKey ?? "none"}</span> · Cohen's κ ${data.promotion.kappa === null ? (e.kappa === null ? "–" : e.kappa.toFixed(2)) : data.promotion.kappa.toFixed(2)} (minimum ${e.minJudgeKappa}).</p>`;
	if (data.run.promotion === "approved") return html`${evidence}<p>Approved ${formatTime(data.run.promotedAt)}. Roll back with <code>nexo optimize rollback ${data.run.id}</code>.</p>`;
	if (data.promotion.allowed) {
		return readOnly
			? html`${evidence}<p class="muted">The UI is read-only; approve with <code>nexo optimize approve ${data.run.id}</code>.</p>`
			: html`${evidence}<p><button type="button" class="primary" data-approve="${data.run.id}">Approve ${version(data.run.bestVersion)}</button> makes it the active version and retires ${version(data.run.baseVersion)}.</p>`;
	}
	const review = runsToReview(data.promotion);
	return html`${evidence}<div class="error" role="note"><strong>Cannot approve</strong> ${data.promotion.error?.message ?? ""}${data.promotion.error?.hint ? html`<div class="hint">${data.promotion.error.hint}</div>` : ""}</div>
${review.length > 0 ? html`<p>Review these runs to calibrate the judge:</p><ul>${review.map((id) => html`<li><a href="${runLink(id)}">${id}</a></li>`)}</ul>` : ""}`;
}

/** One optimization: header, holdout report, approval, diff and lineage. */
export function renderOptimDetail(data: OptimDetailResponse, readOnly: boolean): SafeHtml {
	const r = data.run;
	return html`<h2>${r.target} ${statusBadge(r.status)}</h2>
<p class="muted mono">${r.id} · ${version(r.baseVersion)} → ${version(r.bestVersion)} · ${formatUsd(r.spentUsd)} of $${r.budgetUsd.toFixed(2)} · ${r.rollouts} rollouts · seed ${r.seed}</p>
${r.error ? html`<div class="error" role="alert"><strong>${r.error.code}</strong> ${r.error.message}</div>` : ""}
${data.report ? renderHoldout(data.report) : html`<p class="muted">No report: ${r.status === "running" ? "the optimization is still running" : "the optimization did not finish"}.</p>`}
${renderApproval(data, readOnly)}
${data.report ? html`<h3>Text diff</h3>${renderDiff(data.report.diff)}` : ""}
<h3>Lineage</h3>${renderLineage(data.candidates)}`;
}
