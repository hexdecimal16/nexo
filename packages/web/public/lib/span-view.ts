import type { Span, SpanNode } from "./api-types.ts";
import { statusBadge } from "./common-view.ts";
import { durationMs, formatDuration, formatUsd, shortId } from "./format.ts";
import { html, prettyJson, type SafeHtml } from "./html.ts";

export function findSpan(roots: SpanNode[], id: string): SpanNode | undefined {
	const stack = [...roots];
	while (stack.length) {
		const node = stack.pop() as SpanNode;
		if (node.span.id === id) return node;
		stack.push(...node.children);
	}
	return undefined;
}

function modelLabel(span: Span): string {
	if (!span.model) return "";
	const parts = [`${span.provider ?? "?"}/${span.model}`];
	if (span.effort) parts.push(`effort ${span.effort}`);
	if (span.modelSource) parts.push(`via ${span.modelSource}`);
	return parts.join(" · ");
}

export function spanLine(span: Span, nowMs: number): SafeHtml {
	const subagentRun = span.kind === "subagent" && typeof span.attrs.trajectoryId === "string" ? shortId(span.attrs.trajectoryId) : null;
	return html`<span class="kind kind-${span.kind}">${span.kind}</span> <span class="span-name">${span.name}</span>${subagentRun ? html` <span class="muted mono">${subagentRun}</span>` : ""} ${statusBadge(span.status)} <span class="muted mono">${formatDuration(durationMs(span.startedAt, span.endedAt, nowMs))}${span.costUsd > 0 || span.costUnknown ? ` · ${formatUsd(span.costUsd, span.costUnknown)}` : ""}${span.model ? ` · ${modelLabel(span)}` : ""}</span>`;
}

/** Nested <details> list; nodes deeper than `openDepth` start collapsed. Each summary carries data-span-id. */
export function renderSpanTree(roots: SpanNode[], nowMs: number, openDepth: number = 2): SafeHtml {
	const renderNode = (node: SpanNode, depth: number): SafeHtml => {
		const line = spanLine(node.span, nowMs);
		if (node.children.length === 0) {
			return html`<li><button type="button" class="span-leaf" data-span-id="${node.span.id}">${line}</button></li>`;
		}
		return html`<li><details${depth < openDepth || node.span.kind === "subagent" ? html` open` : ""}><summary data-span-id="${node.span.id}">${line}</summary><ul>${node.children.map((c) => renderNode(c, depth + 1))}</ul></details></li>`;
	};
	if (roots.length === 0) return html`<p class="muted">No spans recorded.</p>`;
	return html`<ul class="tree">${roots.map((r) => renderNode(r, 0))}</ul>`;
}

function fileButton(runId: string, path: string, label: string): SafeHtml {
	return html`<button type="button" class="link" data-file-run="${runId}" data-file-path="${path}">${label}</button>`;
}

function renderContentBlocks(content: unknown): SafeHtml {
	if (!Array.isArray(content)) return html`<pre>${prettyJson(content)}</pre>`;
	return html`${content.map((block: unknown) => {
		const b = (block ?? {}) as Record<string, unknown>;
		if (b.type === "text") return html`<div class="msg msg-text"><div class="msg-label">assistant</div><pre>${String(b.text ?? "")}</pre></div>`;
		if (b.type === "thinking") return html`<div class="msg msg-thinking"><div class="msg-label">thinking${b.redacted ? " (redacted)" : ""}</div><pre>${String(b.thinking ?? "")}</pre></div>`;
		if (b.type === "toolCall") return html`<div class="msg msg-tool"><div class="msg-label">tool call · ${String(b.name ?? "")}</div><pre>${prettyJson(b.arguments)}</pre></div>`;
		return html`<pre>${prettyJson(b)}</pre>`;
	})}`;
}

const SHOWN_ATTRS = new Set(["content", "args", "result", "reason", "trigger", "instruction", "errorMessage"]);

/** Fields, messages, tool input and output, and remaining attributes of one span. */
export function renderSpanDetail(span: Span, attrsTruncated: boolean, nowMs: number): SafeHtml {
	const a = span.attrs;
	const rest = Object.fromEntries(Object.entries(a).filter(([k, v]) => !SHOWN_ATTRS.has(k) && v !== undefined && v !== null));
	const rows: [string, unknown][] = [
		["kind", span.kind],
		["status", span.status],
		["started", span.startedAt],
		["duration", formatDuration(durationMs(span.startedAt, span.endedAt, nowMs)) + (span.endedAt === null ? " (running)" : "")],
		["queued", span.queuedMs === null ? null : formatDuration(span.queuedMs)],
		["model", span.model ? `${span.provider ?? "?"}/${span.model}` : null],
		["tier", span.tier],
		["effort", span.effort],
		["model source", span.modelSource],
		["tokens", span.tokensIn || span.tokensOut ? `${span.tokensIn} in · ${span.tokensOut} out · ${span.cacheRead} cache read · ${span.cacheWrite} cache write` : null],
		["cost", span.costUsd > 0 || span.costUnknown ? formatUsd(span.costUsd, span.costUnknown) : null],
	];
	return html`<div class="span-detail">
	<h3>${span.name}</h3>
	<dl>${rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}</dl>
	${attrsTruncated ? html`<p class="note">Long values are shortened here. <button type="button" class="link" data-full-span="${span.id}">Load the full span</button></p>` : ""}
	${typeof a.reason === "string" || typeof a.trigger === "string" ? html`<div class="msg msg-escalation"><div class="msg-label">reason${typeof a.trigger === "string" ? ` · trigger ${a.trigger}` : ""}</div><pre>${String(a.reason ?? "")}</pre></div>` : ""}
	${typeof a.errorMessage === "string" ? html`<div class="msg msg-error"><div class="msg-label">error</div><pre>${a.errorMessage}</pre></div>` : ""}
	${typeof a.instruction === "string" ? html`<div class="msg"><div class="msg-label">instruction</div><pre>${a.instruction}</pre></div>` : ""}
	${a.content !== undefined ? renderContentBlocks(a.content) : ""}
	${a.args !== undefined ? html`<div class="msg msg-tool"><div class="msg-label">input</div><pre>${prettyJson(a.args)}</pre></div>` : ""}
	${typeof a.result === "string" ? html`<div class="msg msg-result"><div class="msg-label">output</div><pre>${a.result}</pre></div>` : ""}
	${span.payloadRef ? html`<p class="note">Full payload stored in ${fileButton(span.runId, span.payloadRef, span.payloadRef)}</p>` : ""}
	${Object.keys(rest).length ? html`<details><summary>attributes</summary><pre>${prettyJson(rest)}</pre></details>` : ""}
</div>`;
}
