import type { SpanNode } from "./api-types.ts";
import { durationMs, formatDuration, formatUsd, shortId } from "./format.ts";
import { html, type SafeHtml } from "./html.ts";

export interface TimelineRow {
	spanId: string;
	label: string;
	runId: string | null;
	depth: number;
	startMs: number;
	queuedMs: number;
	durationMs: number;
	costUsd: number;
	status: string;
	running: boolean;
}

export interface Timeline {
	rows: TimelineRow[];
	originMs: number;
	totalMs: number;
}

/** Gantt rows: the top-level run span, then every subagent span at any depth in start order. */
export function timelineRows(roots: SpanNode[], nowMs: number): Timeline {
	const rows: TimelineRow[] = [];
	const visit = (node: SpanNode, depth: number): void => {
		const span = node.span;
		const isRun = span.kind === "run" && depth === 0;
		if (isRun || span.kind === "subagent") {
			const child = span.attrs.trajectoryId;
			const childCost = span.attrs.childCostUsd;
			rows.push({
				spanId: span.id,
				label: isRun ? "run" : `${span.name}${typeof child === "string" ? ` · ${shortId(child)}` : ""}`,
				runId: isRun ? span.runId : typeof child === "string" ? child : null,
				depth: isRun ? 0 : depth + 1,
				startMs: Date.parse(span.startedAt),
				queuedMs: span.queuedMs ?? 0,
				durationMs: durationMs(span.startedAt, span.endedAt, nowMs),
				costUsd: typeof childCost === "number" ? childCost : span.costUsd,
				status: span.status,
				running: span.endedAt === null,
			});
		}
		for (const c of node.children) visit(c, span.kind === "subagent" ? depth + 1 : depth);
	};
	for (const root of roots) visit(root, 0);
	if (rows.length === 0) return { rows, originMs: 0, totalMs: 0 };
	const originMs = Math.min(...rows.map((r) => r.startMs - r.queuedMs));
	const endMs = Math.max(...rows.map((r) => r.startMs + r.durationMs));
	return { rows, originMs, totalMs: Math.max(1, endMs - originMs) };
}

const WIDTH = 1000;

function scaled(ms: number, total: number): string {
	return ((ms / total) * WIDTH).toFixed(1);
}

const TICK_STEPS_MS = [1e3, 2e3, 5e3, 1e4, 3e4, 6e4, 12e4, 3e5, 6e5, 18e5, 36e5];
const MAX_TICKS = 60;

/** Gridline spacing for a timeline of `totalMs`: the first round step that gives at most 10 intervals. */
export function tickStepMs(totalMs: number): number {
	return TICK_STEPS_MS.find((step) => totalMs / step <= 10) ?? 36e5;
}

function renderTicks(totalMs: number): SafeHtml {
	const step = tickStepMs(totalMs);
	const xs: string[] = [];
	for (let t = step; t < totalMs && xs.length < MAX_TICKS; t += step) xs.push(scaled(t, totalMs));
	return html`${xs.map((x) => html`<line class="tl-tick" x1="${x}" x2="${x}" y1="0" y2="10"></line>`)}`;
}

/** One SVG bar per row over a shared time grid, with a ruler above and a cap on running rows (geometry in attributes, so the page CSP needs no inline styles). */
export function renderTimeline(timeline: Timeline): SafeHtml {
	if (timeline.rows.length === 0) return html`<p class="muted">No run spans recorded yet.</p>`;
	const ticks = renderTicks(timeline.totalMs);
	return html`<div class="timeline"><div class="tl-scale"><span></span><span><span>0s</span><span>${formatDuration(timeline.totalMs)}</span></span><span></span></div>${timeline.rows.map((row) => {
		const queueStart = row.startMs - row.queuedMs - timeline.originMs;
		const runStart = row.startMs - timeline.originMs;
		const runX = scaled(runStart, timeline.totalMs);
		const runW = scaled(Math.max(row.durationMs, timeline.totalMs / WIDTH), timeline.totalMs);
		const headX = Math.max(0, Number(runX) + Number(runW) - 3).toFixed(1);
		return html`<div class="tl-row">
		<button type="button" class="tl-label depth-${Math.min(row.depth, 6)}" data-span-id="${row.spanId}">${row.label}</button>
		<svg class="tl-bar" viewBox="0 0 ${WIDTH} 10" preserveAspectRatio="none" role="img" aria-label="${row.label}">
			${ticks}
			${row.queuedMs > 0 ? html`<rect class="tl-queue" x="${scaled(queueStart, timeline.totalMs)}" y="2" width="${scaled(row.queuedMs, timeline.totalMs)}" height="6"></rect>` : ""}
			<rect class="tl-run tl-${row.running ? "running" : row.status}" x="${runX}" y="0" width="${runW}" height="10"></rect>
			${row.running ? html`<rect class="tl-head" x="${headX}" y="0" width="3" height="10"></rect>` : ""}
		</svg>
		<span class="tl-meta mono">${row.queuedMs > 0 ? `queued ${formatDuration(row.queuedMs)} · ` : ""}${formatDuration(row.durationMs)}${row.running ? " (running)" : ""} · ${formatUsd(row.costUsd)}</span>
	</div>`;
	})}</div>`;
}
