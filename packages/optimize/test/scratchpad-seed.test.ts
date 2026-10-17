import { describe, expect, it } from "vitest";
import { type EvalCase, type GepaAdapter, mulberry32, runGepa, type Scratchpad } from "../src/index.ts";

const cases = (prefix: string, n: number): EvalCase[] =>
	Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, input: `${prefix} ${i}`, skill: null, expected: null, referenceFeedback: null, sourceRunId: null }));

describe("scratchpad seed", () => {
	it("shows the given scratchpad to the first reflection and returns it without changing the input", async () => {
		const seen: unknown[] = [];
		const adapter: GepaAdapter = {
			async evaluate(batch) {
				return { scores: batch.map(() => ({ quality: 0.1, costUsd: 0.01 })), traces: null };
			},
			makeReflectiveDataset: (_c, _b, components) => Object.fromEntries(components.map((c) => [c, []])),
			async proposeNewTexts(_c, _d, _k, _s, hints) {
				seen.push(structuredClone(hints));
				return null;
			},
		};
		const given: Scratchpad = { patterns: ["Ask first."], antiPatterns: ["Longer lists."] };
		const result = await runGepa({
			adapter,
			callbacks: {
				createCandidate: () => {
					throw new Error("no candidate expected");
				},
				recordMinibatch: () => {},
				recordPareto: () => {},
				canStartIteration: () => null,
			},
			seed: { id: "s", artifactId: "a", texts: { body: "v1" } },
			seedPareto: { p0: { quality: 0.1, costUsd: 0.01 } },
			components: ["body"],
			feedback: cases("f", 3),
			pareto: cases("p", 1),
			patience: 1,
			merge: false,
			rng: mulberry32(1),
			signal: new AbortController().signal,
			scratchpad: given,
		});
		expect(seen[0]).toEqual(given);
		expect(result.scratchpad).toEqual(given);
		expect(given).toEqual({ patterns: ["Ask first."], antiPatterns: ["Longer lists."] });
	});
});
