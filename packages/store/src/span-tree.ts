import type { Db } from "./db.ts";
import { descendantRunIds } from "./runs.ts";
import { listSpansForRuns, type SpanRow } from "./spans.ts";

/** Largest span tree returned in one response; deeper history is reported as `truncated`. */
export const MAX_TREE_SPANS = 5000;

/** Longest string kept in a tree node's attrs; the full span is available by id. */
export const ATTR_PREVIEW_CHARS = 4000;

export interface SpanNode {
	span: SpanRow;
	attrsTruncated: boolean;
	children: SpanNode[];
}

export interface SpanTree {
	roots: SpanNode[];
	total: number;
	truncated: boolean;
}

/** Deep copy of `value` with every string longer than `max` cut to `max` characters plus a marker. */
export function trimAttrs(value: unknown, max: number): { value: unknown; truncated: boolean } {
	let truncated = false;
	const walk = (v: unknown, depth: number): unknown => {
		if (typeof v === "string") {
			if (v.length <= max) return v;
			truncated = true;
			return `${v.slice(0, max)}… [${v.length - max} more characters]`;
		}
		if (v === null || typeof v !== "object") return v;
		if (depth > 32) {
			truncated = true;
			return "[nested too deeply]";
		}
		if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(v)) out[key] = walk(item, depth + 1);
		return out;
	};
	return { value: walk(value, 0), truncated };
}

/**
 * Nests spans by `parentSpanId`. A child run's root `run` span has no parentSpanId; it hangs under the parent run's
 * `subagent` span named in its `attrs.parentSpanId`, or under the subagent span whose `attrs.trajectoryId` is that
 * child run. Spans whose parent is absent (outside the list or truncated away) become roots; a corrupt parent cycle
 * is broken by making its first member a root.
 */
export function buildSpanTree(spans: readonly SpanRow[], previewChars: number = ATTR_PREVIEW_CHARS): SpanNode[] {
	const nodes = new Map<string, SpanNode>();
	const subagentByRun = new Map<string, string>();
	for (const span of spans) {
		const trimmed = trimAttrs(span.attrs, previewChars);
		nodes.set(span.id, { span: { ...span, attrs: trimmed.value as Record<string, unknown> }, attrsTruncated: trimmed.truncated, children: [] });
		const child = span.attrs.trajectoryId;
		if (span.kind === "subagent" && typeof child === "string") subagentByRun.set(child, span.id);
	}
	const parentOf = (span: SpanRow): string | null => {
		if (span.parentSpanId && nodes.has(span.parentSpanId)) return span.parentSpanId;
		if (span.kind !== "run") return null;
		const linked = span.attrs.parentSpanId;
		if (typeof linked === "string" && nodes.has(linked)) return linked;
		return subagentByRun.get(span.runId) ?? null;
	};
	const roots: SpanNode[] = [];
	for (const span of spans) {
		const node = nodes.get(span.id) as SpanNode;
		const parent = parentOf(span);
		if (parent && parent !== span.id) (nodes.get(parent) as SpanNode).children.push(node);
		else roots.push(node);
	}
	const reached = new Set<string>();
	const stack = [...roots];
	while (stack.length) {
		const node = stack.pop() as SpanNode;
		if (reached.has(node.span.id)) continue;
		reached.add(node.span.id);
		stack.push(...node.children);
	}
	for (const span of spans) {
		if (reached.has(span.id)) continue;
		const node = nodes.get(span.id) as SpanNode;
		for (const other of nodes.values()) other.children = other.children.filter((c) => c !== node);
		roots.push(node);
		const again = [node];
		while (again.length) {
			const next = again.pop() as SpanNode;
			if (reached.has(next.span.id)) continue;
			reached.add(next.span.id);
			again.push(...next.children);
		}
	}
	return roots;
}

/** The span tree of a run and all of its subagent runs. */
export function loadSpanTree(db: Db, runId: string, options: { maxSpans?: number; previewChars?: number } = {}): SpanTree {
	const { spans, total } = listSpansForRuns(db, descendantRunIds(db, runId), options.maxSpans ?? MAX_TREE_SPANS);
	return { roots: buildSpanTree(spans, options.previewChars), total, truncated: total > spans.length };
}
