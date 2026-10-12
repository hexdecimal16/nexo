import { describe, expect, it } from "vitest";
import type { CaseScore, MinibatchRecord, OptimStopReason } from "@nexo/store";
import {
	BudgetStop,
	type CandidateRef,
	type ComponentTexts,
	type EvalCase,
	type GepaAdapter,
	type GepaCallbacks,
	type GepaEvent,
	MAX_MERGES,
	MINIBATCH_SIZE,
	mulberry32,
	runGepa,
} from "../src/index.ts";

const cases = (prefix: string, n: number): EvalCase[] =>
	Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, input: `${prefix} task ${i}`, skill: null, expected: null, referenceFeedback: null, sourceRunId: null }));

const FEEDBACK = cases("f", 4);
const PARETO = cases("p", 4);

const num = (text: string | undefined) => Number(/v(\d+)/.exec(text ?? "")?.[1] ?? 0);

/**
 * Fake scoring: a text's quality comes from the number after "v" (v3 → 0.3). Feedback cases score the sum over the
 * components; on pareto cases component `a` (or `body`) decides the even cases and `b` the odd ones. Bigger numbers
 * cost more, so the seed stays the cheapest candidate.
 */
function score(texts: ComponentTexts, caseId: string): CaseScore {
	const total = Object.values(texts).reduce((sum, t) => sum + num(t), 0);
	const pareto = /^p(\d+)$/.exec(caseId);
	const even = Number(pareto?.[1] ?? 0) % 2 === 0;
	const value = !pareto ? total : texts.body !== undefined ? num(texts.body) : num(even ? texts.a : texts.b);
	return { quality: value / 10, costUsd: 0.01 * (1 + total) };
}
const quality = (texts: ComponentTexts) => score(texts, "f").quality;

interface Harness {
	adapter: GepaAdapter;
	callbacks: GepaCallbacks;
	created: { parentIds: string[]; texts: ComponentTexts; origin: string; component: string | null }[];
	minibatches: { id: string; record: MinibatchRecord; accepted: boolean }[];
	pareto: { id: string; accepted: boolean }[];
	components: string[];
	evaluations: { candidate: string; cases: string[] }[];
	events: GepaEvent[];
}

function harness(proposals: (ComponentTexts | null)[], options: { stopBefore?: (h: Harness) => OptimStopReason | null; failOn?: (candidate: string, n: number) => boolean } = {}): Harness {
	let next = 0;
	let evalCount = 0;
	const h: Harness = {
		created: [],
		minibatches: [],
		pareto: [],
		components: [],
		evaluations: [],
		events: [],
		adapter: {
			async evaluate(batch, candidate, captureTraces) {
				evalCount++;
				if (options.failOn?.(candidate.id, evalCount)) throw new BudgetStop("budget_usd", "out of money");
				h.evaluations.push({ candidate: candidate.id, cases: batch.map((c) => c.id) });
				const scores: CaseScore[] = batch.map((c) => score(candidate.texts, c.id));
				return { scores, traces: captureTraces ? batch.map((c) => ({ instruction: c.input, status: "succeeded", output: "", trajectory: "", scores: [], quality: quality(candidate.texts), reference: null, feedback: null })) : null };
			},
			makeReflectiveDataset(_candidate, evalBatch, components) {
				return Object.fromEntries(components.map((c) => [c, evalBatch.traces ?? []]));
			},
			async proposeNewTexts(_candidate, _dataset, components) {
				h.components.push(...components);
				const p = proposals[next++];
				return p === undefined ? null : p;
			},
		},
		callbacks: {
			createCandidate(input) {
				h.created.push(input);
				return { id: `c${h.created.length}`, artifactId: `a${h.created.length}`, texts: input.texts };
			},
			recordMinibatch(id, record, accepted) {
				h.minibatches.push({ id, record, accepted });
			},
			recordPareto(id, _perCase, accepted) {
				h.pareto.push({ id, accepted });
			},
			canStartIteration: () => options.stopBefore?.(h) ?? null,
			onEvent: (e) => h.events.push(e),
		},
	};
	return h;
}

function seed(texts: ComponentTexts): { seed: CandidateRef; seedPareto: Record<string, CaseScore> } {
	return { seed: { id: "seed", artifactId: "a0", texts }, seedPareto: Object.fromEntries(PARETO.map((c) => [c.id, score(texts, c.id)])) };
}

const run = (h: Harness, texts: ComponentTexts, extra: Partial<Parameters<typeof runGepa>[0]> = {}) =>
	runGepa({ adapter: h.adapter, callbacks: h.callbacks, ...seed(texts), components: Object.keys(texts), feedback: FEEDBACK, pareto: PARETO, patience: 2, merge: false, rng: mulberry32(1), signal: new AbortController().signal, ...extra });

describe("runGepa", () => {
	it("accepts an improving child, evaluates it on the whole pareto split and makes it the best", async () => {
		const h = harness([{ body: "v3" }]);
		const result = await run(h, { body: "v1" });
		expect(h.created[0]).toMatchObject({ parentIds: ["seed"], texts: { body: "v3" }, origin: "reflect", component: "body" });
		expect(h.minibatches[0]).toMatchObject({ id: "c1", accepted: true });
		expect(h.minibatches[0]?.record.caseIds).toHaveLength(MINIBATCH_SIZE);
		expect(h.evaluations.find((e) => e.candidate === "c1" && e.cases.length === PARETO.length)).toBeDefined();
		expect(result.bestId).toBe("c1");
		expect([...result.table.keys()]).toEqual(["seed", "c1"]);
		expect(result.stopReason).toBe("patience");
		expect(h.events.some((e) => e.type === "pareto" && e.newMember)).toBe(true);
	});

	it("rejects a child whose minibatch does not improve and never evaluates it on the pareto split", async () => {
		const h = harness([{ body: "v2" }, { body: "v1 again" }]);
		const result = await run(h, { body: "v2 base" });
		expect(h.minibatches.map((m) => m.accepted)).toEqual([false, false]);
		expect(h.evaluations.filter((e) => e.cases.length === PARETO.length)).toHaveLength(0);
		expect(result).toMatchObject({ bestId: "seed", stopReason: "patience", iterations: 2 });
		expect([...result.table.keys()]).toEqual(["seed"]);
	});

	it("counts an unusable reflection toward patience", async () => {
		const h = harness([null, null, null]);
		const result = await run(h, { body: "v1" }, { patience: 3 });
		expect(result).toMatchObject({ iterations: 3, stopReason: "patience" });
		expect(h.created).toHaveLength(0);
		expect(h.events.filter((e) => e.type === "rejected")).toHaveLength(3);
	});

	it("rejects a proposal identical to an existing candidate without creating it", async () => {
		const h = harness([{ body: "v1" }, { body: "v3" }, { body: "v3" }]);
		const result = await run(h, { body: "v1" }, { patience: 2 });
		expect(h.created.map((c) => c.texts.body)).toEqual(["v3"]);
		expect(h.events.filter((e) => e.type === "rejected").map((e) => (e.type === "rejected" ? e.reason : ""))).toEqual([
			"the proposed text is already a candidate",
			"the proposed text is already a candidate",
			"the reflection produced no usable text",
		]);
		expect(result.bestId).toBe("c1");
	});

	it("rotates components round-robin", async () => {
		const h = harness([{ a: "v2" }, { b: "v3" }, { a: "v4" }, { b: "v0" }], { stopBefore: (x) => (x.components.length >= 4 ? "budget_rollouts" : null) });
		await run(h, { a: "v1", b: "v0" }, { patience: 10 });
		expect(h.components).toEqual(["a", "b", "a", "b"]);
	});

	it("stops before an iteration the budget cannot cover", async () => {
		const h = harness([{ body: "v2" }], { stopBefore: () => "budget_rollouts" });
		const result = await run(h, { body: "v1" });
		expect(result).toMatchObject({ iterations: 0, stopReason: "budget_rollouts", bestId: "seed" });
	});

	it("stops mid-iteration when a rollout cannot be paid for, keeping the unevaluated child out of the pool", async () => {
		const h = harness([{ body: "v9" }], { failOn: (candidate) => candidate === "c1" });
		const result = await run(h, { body: "v1" });
		expect(result).toMatchObject({ stopReason: "budget_usd", bestId: "seed", iterations: 1 });
		expect(h.created).toHaveLength(1);
		expect([...result.table.keys()]).toEqual(["seed"]);
		expect(h.pareto).toEqual([]);
	});

	it("stops with aborted when the signal fires", async () => {
		const controller = new AbortController();
		const h = harness([{ body: "v2" }]);
		h.adapter.evaluate = async () => {
			controller.abort();
			throw new Error("aborted");
		};
		const result = await run(h, { body: "v1" }, { signal: controller.signal });
		expect(result.stopReason).toBe("aborted");
	});

	it("merges two front members that changed different components, at most MAX_MERGES times", async () => {
		const proposals: ComponentTexts[] = [];
		for (let i = 0; i < 40; i++) proposals.push(i % 2 === 0 ? { a: `v${2 + i}` } : { b: `v${2 + i}` });
		const h = harness(proposals, { stopBefore: (x) => (x.components.length >= 30 ? "budget_rollouts" : null) });
		const result = await run(h, { a: "v1", b: "v1" }, { merge: true, patience: 100 });
		const merges = h.created.filter((c) => c.origin === "merge");
		expect(merges.length).toBeGreaterThan(0);
		expect(merges.length).toBeLessThanOrEqual(MAX_MERGES);
		expect(result.merges).toBe(merges.length);
		expect(merges[0]?.parentIds).toHaveLength(2);
	});

	it("never merges single-component candidates", async () => {
		const h = harness([{ body: "v2" }, { body: "v3" }, { body: "v4" }]);
		const result = await run(h, { body: "v1" }, { merge: true, patience: 5 });
		expect(result.merges).toBe(0);
	});
});
