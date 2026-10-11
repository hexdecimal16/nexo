import type { Escalation, RunScore, Score, Verdict } from "./api-types.ts";
import { formatTime, formatUsd } from "./format.ts";
import { html, type SafeHtml } from "./html.ts";

/** `0.82 ✓` / `0.40 ✗` for a run's latest scoring round; `–` when never scored, `failed` when no scorer answered. */
export function renderScoreCell(score: RunScore | null): SafeHtml {
	if (!score) return html`<span class="muted">–</span>`;
	if (score.scorers === 0) return html`<span class="badge score-failed" title="every scorer failed">failed</span>`;
	const value = score.value === null ? "–" : score.value.toFixed(2);
	return html`<span class="badge ${score.passed ? "score-pass" : "score-fail"}">${value} ${score.passed ? "✓" : "✗"}</span>${score.failedScorers ? html` <span class="warn" title="scorers that failed">+${score.failedScorers} failed</span>` : ""}`;
}

/** The same-family pairs a judge score recorded in `details.sameFamily`. */
function sameFamily(score: Score): { judge: string; generator: string; family: string }[] {
	const raw = score.details.sameFamily;
	return Array.isArray(raw) ? (raw as { judge: string; generator: string; family: string }[]) : [];
}

interface Vote {
	model: string;
	score: number | null;
	passed: boolean | null;
	rationale?: string;
	repaired?: boolean;
	error?: string;
}

function renderVotes(score: Score): SafeHtml {
	const votes = Array.isArray(score.details.votes) ? (score.details.votes as Vote[]) : [];
	if (votes.length < 2 && !votes.some((v) => v.repaired)) return html``;
	return html`<ul class="votes">${votes.map(
		(v) => html`<li><span class="mono">${v.model}</span> ${v.score === null ? html`<span class="warn">failed: ${v.error ?? ""}</span>` : html`${v.score.toFixed(2)} ${v.passed ? "pass" : "fail"}`}${v.repaired ? html` <span class="muted">(after one repair)</span>` : ""}</li>`,
	)}</ul>`;
}

function renderScore(score: Score): SafeHtml {
	const family = sameFamily(score);
	return html`<div class="score">
	<div class="facts">
		<strong>${score.scorerName}</strong>
		<span class="kind">${score.scorerType}</span>
		${score.status === "failed"
			? html`<span class="badge score-failed">failed</span>`
			: html`<span class="badge ${score.passed ? "score-pass" : "score-fail"}">${score.value === null ? "–" : score.value.toFixed(2)} ${score.passed ? "pass" : "fail"}</span>`}
		${score.model ? html`<span class="mono">${score.model}</span>` : ""}
		${score.costUsd > 0 || score.costUnknown ? html`<span>${formatUsd(score.costUsd, score.costUnknown)}</span>` : ""}
		${family.length ? html`<span class="badge badge-warn" title="${family.map((f) => `${f.judge} and ${f.generator} are both ${f.family} models`).join("; ")}">same-family judge</span>` : ""}
	</div>
	${score.error ? html`<div class="error"><strong>${score.error.code}</strong> ${score.error.message}${score.error.hint ? html`<div class="hint">${score.error.hint}</div>` : ""}</div>` : ""}
	${score.rationale ? html`<pre class="rationale">${score.rationale}</pre>` : ""}
	${score.criteria?.length ? html`<ul class="criteria">${score.criteria.map((c) => html`<li class="${c.passed ? "crit-pass" : "crit-fail"}">${c.passed ? "✓" : "✗"} <strong>${c.name}</strong> ${c.note}</li>`)}</ul>` : ""}
	${renderVotes(score)}
</div>`;
}

/**
 * Scores of a run (the judge reasoning panel): the latest round in full, earlier rounds collapsed. A human verdict takes
 * priority over every automatic score and is shown first; a judge that disagrees with it is flagged.
 */
export function renderScores(scores: readonly Score[], verdict: Verdict | null, disagrees: boolean): SafeHtml {
	if (scores.length === 0) return html`<p class="muted">No scorer ran for this run.</p>`;
	const latest = Math.max(...scores.map((s) => s.round));
	const earlier = [...new Set(scores.filter((s) => s.round < latest).map((s) => s.round))];
	return html`${verdict ? html`<p class="human-priority">Human verdict: <strong>${verdict === "done" ? "done" : "not done"}</strong> — it takes priority over the automatic scores below.${disagrees ? html` <span class="badge badge-warn">judge disagrees</span>` : ""}</p>` : ""}
<div class="scores">${scores.filter((s) => s.round === latest).map(renderScore)}</div>
${earlier.map(
	(round) => html`<details class="score-round"><summary>Round ${round} (before escalation ${round + 1})</summary>${scores.filter((s) => s.round === round).map(renderScore)}</details>`,
)}`;
}

/** Escalation reasons: each trigger, whether it switched to S2, and why not when it was suppressed. */
export function renderEscalations(escalations: readonly Escalation[]): SafeHtml {
	if (escalations.length === 0) return html`<p class="muted">The run stayed on its model.</p>`;
	return html`<ul class="escalations">${escalations.map(
		(e) => html`<li class="${e.applied ? "esc-applied" : "esc-blocked"}">
	<span class="mono">${formatTime(e.at)}</span>
	<strong>${e.trigger}</strong> <span class="kind">${e.phase.replace("_", "-")}</span>
	${e.applied ? html`${e.from ?? "?"} → <span class="mono">${e.to ?? "?"}</span>` : html`<span class="warn">suppressed: ${e.blockedBy ?? "unknown"}</span>`}
	<div class="muted">${e.reason}</div>
	${e.blockedReason ? html`<div class="muted">blocked: ${e.blockedReason}</div>` : ""}
	${e.continuationError ? html`<div class="error">continuation failed: <strong>${e.continuationError.code}</strong> ${e.continuationError.message}</div>` : ""}
</li>`,
	)}</ul>`;
}
