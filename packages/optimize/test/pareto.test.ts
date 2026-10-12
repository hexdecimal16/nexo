import { describe, expect, it } from "vitest";
import { parseOptimTarget } from "@nexo/store";
import {
	bestCandidate,
	caseDominates,
	commonAncestor,
	contentOf,
	findMerge,
	type LineageNode,
	meanOf,
	mergeTexts,
	mulberry32,
	paretoMembers,
	pickWeighted,
	sampleWithoutReplacement,
	type ScoreTable,
	selectCandidate,
	splitSkillContent,
	targetComponents,
	textsOf,
	winCounts,
} from "../src/index.ts";

const s = (quality: number, costUsd: number) => ({ quality, costUsd });
const CASES = ["c1", "c2", "c3"];

describe("rng", () => {
	it("repeats a sequence for a seed and samples without replacement", () => {
		const a = mulberry32(42);
		const b = mulberry32(42);
		const seq = Array.from({ length: 5 }, () => a());
		expect(Array.from({ length: 5 }, () => b())).toEqual(seq);
		expect(seq.every((x) => x >= 0 && x < 1)).toBe(true);
		const picked = sampleWithoutReplacement(["a", "b", "c", "d", "e"], 3, mulberry32(7));
		expect(new Set(picked).size).toBe(3);
		expect(sampleWithoutReplacement(["a", "b"], 3, mulberry32(7)).sort()).toEqual(["a", "b"]);
		expect(() => pickWeighted(["a"], [0], mulberry32(1))).toThrow(RangeError);
	});
});

describe("targets", () => {
	it("has one component per target and keeps a skill's frontmatter", () => {
		expect(targetComponents(parseOptimTarget("skill:ci-fix"))).toEqual(["body"]);
		expect(targetComponents(parseOptimTarget("judge_rubric"))).toEqual(["rubric"]);
		const skill = parseOptimTarget("skill:ci-fix");
		const content = "---\nname: ci-fix\ndescription: d\n---\nStep 1.\n";
		expect(splitSkillContent(content)).toEqual({ head: "---\nname: ci-fix\ndescription: d\n---\n", body: "Step 1.\n" });
		expect(textsOf(skill, content)).toEqual({ body: "Step 1.\n" });
		expect(contentOf(skill, content, { body: "Step 1, then run the tests.\n" })).toBe("---\nname: ci-fix\ndescription: d\n---\nStep 1, then run the tests.\n");
		const prompt = parseOptimTarget("system_prompt");
		expect(textsOf(prompt, "Be brief.")).toEqual({ system_prompt: "Be brief." });
		expect(contentOf(prompt, "Be brief.", { system_prompt: "Be exact." })).toBe("Be exact.");
		expect(() => splitSkillContent("no frontmatter")).toThrow(/no YAML frontmatter/);
	});
});

describe("pareto", () => {
	it("treats quality and cost as objectives per case", () => {
		expect(caseDominates(s(1, 0.1), s(1, 0.2))).toBe(true);
		expect(caseDominates(s(1, 0.2), s(0.5, 0.1))).toBe(false);
		expect(caseDominates(s(1, 0.1), s(1, 0.1))).toBe(false);
		const table: ScoreTable = new Map([
			["accurate", { c1: s(1, 0.3), c2: s(1, 0.3), c3: s(0, 0.3) }],
			["cheap", { c1: s(0.5, 0.1), c2: s(0.5, 0.1), c3: s(0, 0.1) }],
			["worse", { c1: s(0.5, 0.2), c2: s(0.5, 0.2), c3: s(0, 0.2) }],
			["c3-only", { c1: s(0, 0.3), c2: s(0, 0.3), c3: s(1, 0.3) }],
		]);
		expect(Object.fromEntries(winCounts(table, CASES))).toEqual({ accurate: 2, cheap: 3, worse: 0, "c3-only": 1 });
		expect(paretoMembers(table, CASES)).toEqual([
			{ id: "accurate", wins: 2 },
			{ id: "cheap", wins: 3 },
			{ id: "c3-only", wins: 1 },
		]);
	});

	it("removes a candidate dominated across all cases even when it ties on some", () => {
		const table: ScoreTable = new Map([
			["a", { c1: s(1, 0.1), c2: s(0.5, 0.1), c3: s(0.5, 0.1) }],
			["b", { c1: s(1, 0.1), c2: s(0.4, 0.1), c3: s(0.5, 0.1) }],
		]);
		expect(winCounts(table, CASES).get("b")).toBe(2);
		expect(paretoMembers(table, CASES).map((m) => m.id)).toEqual(["a"]);
	});

	it("samples members in proportion to their win counts, reproducibly", () => {
		const table: ScoreTable = new Map([
			["three", { c1: s(1, 0.1), c2: s(1, 0.1), c3: s(1, 0.1) }],
			["one", { c1: s(1, 0.1), c2: s(0, 0.1), c3: s(0, 0.1) }],
			["also-three", { c1: s(1, 0.1), c2: s(1, 0.1), c3: s(1, 0.1) }],
		]);
		const rng = mulberry32(3);
		const counts: Record<string, number> = {};
		for (let i = 0; i < 3000; i++) {
			const id = selectCandidate(table, CASES, rng);
			counts[id] = (counts[id] ?? 0) + 1;
		}
		expect(counts.one).toBeUndefined();
		expect((counts.three ?? 0) / 3000).toBeCloseTo(0.5, 1);
		const again = mulberry32(3);
		const first = selectCandidate(table, CASES, mulberry32(3));
		expect(selectCandidate(table, CASES, again)).toBe(first);
		expect(() => selectCandidate(new Map(), CASES, rng)).toThrow(RangeError);
	});

	it("picks the best by mean quality, then cost, then age", () => {
		const table: ScoreTable = new Map([
			["old", { c1: s(1, 0.2), c2: s(0, 0.2), c3: s(1, 0.2) }],
			["cheaper", { c1: s(0, 0.1), c2: s(1, 0.1), c3: s(1, 0.1) }],
			["same", { c1: s(0, 0.1), c2: s(1, 0.1), c3: s(1, 0.1) }],
			["weak", { c1: s(0, 0), c2: s(0, 0), c3: s(1, 0) }],
		]);
		expect(bestCandidate(table, CASES)).toBe("cheaper");
		expect(meanOf(table.get("old") ?? {}, CASES).quality).toBeCloseTo(2 / 3);
		expect(meanOf({}, [])).toEqual({ quality: 0, costUsd: 0 });
	});
});

describe("merge", () => {
	const nodes = new Map<string, LineageNode>([
		["seed", { id: "seed", parentIds: [] }],
		["a", { id: "a", parentIds: ["seed"] }],
		["b", { id: "b", parentIds: ["seed"] }],
		["a2", { id: "a2", parentIds: ["a"] }],
	]);

	it("finds the latest common ancestor and merges disjoint component changes", () => {
		expect(commonAncestor("a2", "b", nodes)).toBe("seed");
		expect(commonAncestor("a", "a2", nodes)).toBe("seed");
		expect(commonAncestor("seed", "a", nodes)).toBeNull();
		expect(mergeTexts({ x: "1", y: "1" }, { x: "2", y: "1" }, { x: "1", y: "3" })).toEqual({ x: "2", y: "3" });
		expect(mergeTexts({ x: "1", y: "1" }, { x: "2", y: "1" }, { x: "3", y: "1" })).toBeNull();
		expect(mergeTexts({ x: "1", y: "1" }, { x: "2", y: "1" }, { x: "1", y: "1" })).toBeNull();
	});

	it("never merges single-component candidates or an ancestor with its descendant", () => {
		const texts = new Map([
			["seed", { body: "s" }],
			["a", { body: "a" }],
			["b", { body: "b" }],
			["a2", { body: "a2" }],
		]);
		expect(findMerge(["a", "b", "a2"], nodes, texts, new Set())).toBeNull();
		const two = new Map([
			["seed", { x: "1", y: "1" }],
			["a", { x: "2", y: "1" }],
			["b", { x: "1", y: "3" }],
			["a2", { x: "4", y: "1" }],
		]);
		expect(findMerge(["a", "a2", "b"], nodes, two, new Set())).toEqual({ a: "a", b: "b", ancestor: "seed", texts: { x: "2", y: "3" } });
		expect(findMerge(["a", "a2", "b"], nodes, two, new Set(["a|b"]))).toEqual({ a: "a2", b: "b", ancestor: "seed", texts: { x: "4", y: "3" } });
	});
});
