import type { Calibration, ConfusionMatrix, JudgeCalibrationResponse } from "./api-types.ts";
import { runLink } from "./common-view.ts";
import { formatTime, truncate } from "./format.ts";
import { html, type SafeHtml } from "./html.ts";

function pct(value: number | null): string {
	return value === null ? "–" : `${(value * 100).toFixed(1)}%`;
}

function kappa(value: number | null): string {
	return value === null ? "–" : value.toFixed(3);
}

function renderMatrix(m: ConfusionMatrix): SafeHtml {
	return html`<table class="matrix">
	<thead><tr><th></th><th class="num">human done</th><th class="num">human not done</th></tr></thead>
	<tbody>
		<tr><th>judge pass</th><td class="num">${m.bothPass}</td><td class="num">${m.judgePassHumanFail}</td></tr>
		<tr><th>judge fail</th><td class="num">${m.judgeFailHumanPass}</td><td class="num">${m.bothFail}</td></tr>
	</tbody>
</table>`;
}

function renderHistory(history: readonly Calibration[]): SafeHtml {
	if (history.length === 0) return html`<p class="muted">No stored calibration yet. Run <code>nexo eval judge</code> to store one.</p>`;
	return html`<table class="runs">
	<thead><tr><th>When (UTC)</th><th>Judge</th><th class="num">Cases</th><th class="num">Accuracy</th><th class="num">Cohen's κ</th></tr></thead>
	<tbody>${history.map(
		(c) => html`<tr><td class="mono">${formatTime(c.createdAt)}</td><td class="mono">${c.judgeKey}</td><td class="num">${c.cases}</td><td class="num">${pct(c.accuracy)}</td><td class="num">${kappa(c.kappa)}</td></tr>`,
	)}</tbody>
</table>`;
}

/** The judge calibration view: current agreement with human verdicts, stored `nexo eval judge` results, disagreements. */
export function renderCalibration(data: JudgeCalibrationResponse): SafeHtml {
	const current = data.current;
	return html`<section>
	<h2>Judge</h2>
	${data.judgeKey ? html`<p class="mono">${data.judgeKey}</p>` : html`<p class="warn">No judge is configured (models.judge). Stored results of every judge are listed below.</p>`}
	${data.warnings.map((w) => html`<p class="badge-line"><span class="badge badge-warn">same-family judge</span> ${w}</p>`)}
</section>
<section>
	<h2>Agreement with human verdicts now</h2>
	${current === null
		? html`<p class="muted">Configure a judge to see its agreement.</p>`
		: current.cases === 0
			? html`<p class="muted">No run has both a score from this judge and a human verdict yet. Review judged runs in the review queue.</p>`
			: html`<div class="facts"><span>${current.cases} cases</span> · <span>accuracy ${pct(current.accuracy)}</span> · <span>Cohen's κ ${kappa(current.kappa)}</span></div>${renderMatrix(current.matrix)}`}
</section>
<section>
	<h2>Stored calibrations</h2>
	${renderHistory(data.history)}
</section>
<section>
	<h2>Disagreements</h2>
	${data.disagreements.length === 0
		? html`<p class="muted">The judge agrees with every human verdict.</p>`
		: html`<ul class="disagreements">${data.disagreements.map(
				(d) => html`<li><a href="${runLink(d.runId)}">${truncate(d.instruction.split("\n")[0] ?? "", 100) || d.runId}</a> — judge ${d.judgePassed ? "pass" : "fail"}, human ${d.verdict === "done" ? "done" : "not done"}${d.comment ? html` <span class="muted">“${truncate(d.comment, 160)}”</span>` : ""}</li>`,
			)}</ul>`}
</section>`;
}
