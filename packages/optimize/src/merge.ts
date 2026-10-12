import type { ComponentTexts } from "./target.ts";

/** A candidate in the lineage: its id and its parents' ids. */
export interface LineageNode {
	id: string;
	parentIds: string[];
}

/** Every ancestor of `id` (parents, their parents, …), not `id` itself. */
export function ancestors(id: string, nodes: ReadonlyMap<string, LineageNode>): Set<string> {
	const seen = new Set<string>();
	const stack = [...(nodes.get(id)?.parentIds ?? [])];
	while (stack.length > 0) {
		const next = stack.pop() as string;
		if (seen.has(next)) continue;
		seen.add(next);
		stack.push(...(nodes.get(next)?.parentIds ?? []));
	}
	return seen;
}

/** The most recent common ancestor of `a` and `b` (the latest in `nodes` order), or null. */
export function commonAncestor(a: string, b: string, nodes: ReadonlyMap<string, LineageNode>): string | null {
	const ofA = ancestors(a, nodes);
	const ofB = ancestors(b, nodes);
	let found: string | null = null;
	for (const id of nodes.keys()) if (ofA.has(id) && ofB.has(id)) found = id;
	return found;
}

/**
 * System-aware merge (GEPA): each component comes from whichever side changed it since `ancestor`. Returns null when
 * both sides changed the same component differently, or when the result would equal one side (nothing to combine).
 */
export function mergeTexts(ancestor: ComponentTexts, a: ComponentTexts, b: ComponentTexts): ComponentTexts | null {
	const merged: ComponentTexts = {};
	let fromA = false;
	let fromB = false;
	for (const component of Object.keys(ancestor)) {
		const base = ancestor[component] ?? "";
		const textA = a[component] ?? base;
		const textB = b[component] ?? base;
		const changedA = textA !== base;
		const changedB = textB !== base;
		if (changedA && changedB && textA !== textB) return null;
		if (changedA) fromA = true;
		if (changedB && !changedA) fromB = true;
		merged[component] = changedA ? textA : textB;
	}
	return fromA && fromB ? merged : null;
}

export interface MergePlan {
	a: string;
	b: string;
	ancestor: string;
	texts: ComponentTexts;
}

/**
 * The first pair of Pareto members (in order) that is not ancestor and descendant, not tried before, has a common
 * ancestor, and merges without a conflict. `tried` holds `a|b` keys of pairs already merged or attempted.
 */
export function findMerge(
	members: readonly string[],
	nodes: ReadonlyMap<string, LineageNode>,
	texts: ReadonlyMap<string, ComponentTexts>,
	tried: ReadonlySet<string>,
): MergePlan | null {
	for (let i = 0; i < members.length; i++) {
		for (let j = i + 1; j < members.length; j++) {
			const a = members[i] as string;
			const b = members[j] as string;
			if (tried.has(`${a}|${b}`)) continue;
			if (ancestors(a, nodes).has(b) || ancestors(b, nodes).has(a)) continue;
			const ancestor = commonAncestor(a, b, nodes);
			const base = ancestor ? texts.get(ancestor) : undefined;
			const ta = texts.get(a);
			const tb = texts.get(b);
			if (!ancestor || !base || !ta || !tb) continue;
			const merged = mergeTexts(base, ta, tb);
			if (merged) return { a, b, ancestor, texts: merged };
		}
	}
	return null;
}
