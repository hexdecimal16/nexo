import type { Feedback, ReadOnlyInfo, RunDetailResponse, RunStatus, RunSummary } from "./api-types.ts";
import { renderError, runLink, statusBadge, verdictBadge } from "./common-view.ts";
import { durationMs, formatDuration, formatTime, formatUsd, shortId, truncate } from "./format.ts";
import { html, type SafeHtml } from "./html.ts";

export function shouldPoll(status: RunStatus): boolean {
	return status === "running";
}

export function renderRunHeader(detail: RunDetailResponse, nowMs: number): SafeHtml {
	const { run, runJson } = detail;
	const model = runJson?.model;
	return html`<header class="run-header">
	<div class="crumbs">${run.parentRunId ? html`<a href="${runLink(run.parentRunId)}">← parent run ${shortId(run.parentRunId)}</a>` : html`<a href="/">← runs</a>`}</div>
	<h1>${truncate(run.instruction.split("\n")[0] ?? "", 200)}</h1>
	<div class="facts">
		${statusBadge(run.status)} ${verdictBadge(run.verdict)}
		<span class="mono">${run.id}</span>
		<span>${formatTime(run.startedAt)} · ${formatDuration(durationMs(run.startedAt, run.endedAt, nowMs))}${run.status === "running" ? " so far" : ""}</span>
		<span class="${run.costUnknown ? "warn" : ""}">${formatUsd(run.costUsd, run.costUnknown)}</span>
		${model ? html`<span class="mono">${model.provider}/${model.id} · effort ${model.effort} · source ${model.source}${model.role ? ` · ${model.role}` : ""}</span>` : ""}
		${run.skill ? html`<span>skill ${run.skill}</span>` : ""}
	</div>
	${detail.dirMissing ? html`<div class="error" role="alert"><strong>Run directory missing</strong> The index still has this run, but its directory was deleted. Files and run.json are unavailable.<div class="hint">Run nexo reindex to drop runs whose directory is gone.</div></div>` : ""}
	${run.costUnknown ? html`<p class="warn">Some LLM calls in this run have no price; the cost shown leaves them out.</p>` : ""}
	${run.error ? renderError(run.error) : ""}
	<details class="instruction"><summary>Instruction</summary><pre>${run.instruction}</pre></details>
	${runJson?.output ? html`<details class="output" open><summary>Output</summary><pre>${runJson.output}</pre></details>` : ""}
</header>`;
}

/** Done / not-done form for one run. A running run, or a read-only UI, gets a note instead of a form. */
export function renderFeedbackForm(run: RunSummary, latest: Feedback | undefined, readOnly: ReadOnlyInfo | null = null): SafeHtml {
	if (run.status === "running") return html`<p class="muted">Review becomes available when this run finishes.</p>`;
	if (readOnly) {
		return html`<p class="warn">Verdicts are disabled: ${readOnly.message}.${readOnly.hint ? html` <span class="hint">${readOnly.hint}</span>` : ""}</p>`;
	}
	return html`<form class="feedback" data-feedback-run="${run.id}">
	${latest ? html`<p class="muted">Latest verdict: ${verdictBadge(latest.verdict)} ${formatTime(latest.createdAt)}${latest.comment ? html` · “${truncate(latest.comment, 200)}”` : ""}</p>` : ""}
	<fieldset>
		<legend>Was this run done?</legend>
		<label><input type="radio" name="verdict" value="done" required> Done</label>
		<label><input type="radio" name="verdict" value="not_done"> Not done</label>
	</fieldset>
	<label class="comment">Comment <textarea name="comment" rows="2" maxlength="10000" placeholder="What was missing or wrong?"></textarea></label>
	<button type="submit">Save verdict</button>
	<span class="form-status" aria-live="polite"></span>
</form>`;
}

export function renderChildren(children: RunSummary[], nowMs: number, readOnly: ReadOnlyInfo | null = null, latestByRun: Record<string, Feedback> = {}): SafeHtml {
	if (children.length === 0) return html`<p class="muted">This run started no subagents.</p>`;
	return html`<div class="children">${children.map(
		(child) => html`<section class="child">
	<h3><a href="${runLink(child.id)}">${truncate(child.instruction.split("\n")[0] ?? "", 120)}</a></h3>
	<div class="facts">${statusBadge(child.status)} ${verdictBadge(child.verdict)} <span class="mono">${shortId(child.id)}</span> <span>${formatDuration(durationMs(child.startedAt, child.endedAt, nowMs))}</span> <span class="${child.costUnknown ? "warn" : ""}">${formatUsd(child.costUsd, child.costUnknown)}</span>${child.modelFinal ? html` <span class="mono">${child.modelFinal}</span>` : ""}</div>
	${renderFeedbackForm(child, latestByRun[child.id], readOnly)}
</section>`,
	)}</div>`;
}
