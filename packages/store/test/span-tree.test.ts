import { describe, expect, it } from "vitest";
import { buildSpanTree, insertRun, insertSpan, loadSpanTree, openDb, type SpanNode, trimAttrs } from "../src/index.ts";
import { runRow, spanRow } from "./fixtures.ts";

const ids = (nodes: SpanNode[]): unknown[] => nodes.map((n) => (n.children.length ? [n.span.name, ids(n.children)] : n.span.name));

describe("buildSpanTree", () => {
	it("nests child-run spans under the parent's subagent span", () => {
		const root = runRow();
		const child = runRow({ parentRunId: root.id, rootRunId: root.id });
		const run = spanRow(root.id, { kind: "run", name: "run" });
		const spawn = spanRow(root.id, { kind: "tool_call", name: "spawn", parentSpanId: run.id });
		const sub = spanRow(root.id, { kind: "subagent", name: "a", parentSpanId: spawn.id, attrs: { trajectoryId: child.id } });
		const childRun = spanRow(child.id, { kind: "run", name: "child-run", attrs: { parentSpanId: sub.id } });
		const childLlm = spanRow(child.id, { kind: "llm_call", name: "llm", parentSpanId: childRun.id });
		expect(ids(buildSpanTree([run, spawn, sub, childRun, childLlm]))).toEqual([["run", [["spawn", [["a", [["child-run", ["llm"]]]]]]]]]);
		const fallback = { ...childRun, attrs: {} };
		expect(ids(buildSpanTree([run, spawn, sub, fallback]))).toEqual([["run", [["spawn", [["a", ["child-run"]]]]]]]);
	});

	it("makes orphans roots and survives a corrupt parent cycle", () => {
		const a = spanRow("r", { name: "a", parentSpanId: "missing" });
		const b = spanRow("r", { name: "b" });
		const c = spanRow("r", { name: "c" });
		b.parentSpanId = c.id;
		c.parentSpanId = b.id;
		const tree = buildSpanTree([a, b, c]);
		expect(tree.map((n) => n.span.name)).toEqual(["a", "b"]);
		expect(ids(tree)).toEqual(["a", ["b", ["c"]]]);
	});

	it("trims long attribute strings and flags the node", () => {
		const span = spanRow("r", { attrs: { result: "y".repeat(50), args: { path: "a.txt" } } });
		const [node] = buildSpanTree([span], 10);
		expect(node?.attrsTruncated).toBe(true);
		expect(node?.span.attrs.result).toBe(`${"y".repeat(10)}… [40 more characters]`);
		expect(node?.span.attrs.args).toEqual({ path: "a.txt" });
		expect(trimAttrs({ a: ["short"] }, 10)).toEqual({ value: { a: ["short"] }, truncated: false });
	});
});

describe("loadSpanTree", () => {
	it("caps the number of spans and reports truncation", () => {
		const db = openDb(":memory:");
		const run = runRow();
		insertRun(db, run);
		for (let i = 0; i < 30; i++) insertSpan(db, spanRow(run.id, { name: `s${i}`, startedAt: `2026-10-10T00:00:${String(i).padStart(2, "0")}.000Z` }));
		const tree = loadSpanTree(db, run.id, { maxSpans: 10 });
		expect(tree).toMatchObject({ total: 30, truncated: true });
		expect(tree.roots).toHaveLength(10);
		expect(loadSpanTree(db, run.id).truncated).toBe(false);
	});
});
