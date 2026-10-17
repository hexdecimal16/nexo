import { describe, expect, it } from "vitest";
import {
	type CandidateRef,
	type ComponentTexts,
	type EvalCase,
	type GepaAdapter,
	type GepaEvent,
	mulberry32,
	type ProposalNotes,
	runGepa,
	type Scratchpad,
} from "../src/index.ts";

const cases = (prefix: string, n: number): EvalCase[] =>
	Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, input: `${prefix} task ${i}`, skill: null, expected: null, referenceFeedback: null, sourceRunId: null }));

/** Quality comes from the number after "v" in the body (v5 -> 0.5); cost grows with it. */
const num = (text: string | undefined) => Number(/v(\d+)/.exec(text ?? "")?.[1] ?? 0);
const seed: CandidateRef = { id: "seed", artifactId: "a0", texts: { body: "v1 base" } };
const seedPareto = { p0: { quality: 0.1, costUsd: 0.02 }, p1: { quality: 0.1, costUsd: 0.02 } };

async function run(proposals: (ComponentTexts | null)[], notes: (ProposalNotes | null)[], patience: number) {
	const events: GepaEvent[] = [];
	const hints: Scratchpad[] = [];
	let call = 0;
	let created = 0;
	let pending: ProposalNotes | null = null;
	const adapter: GepaAdapter = {
		async evaluate(batch, candidate) {
			const n = num(candidate.texts.body);
			return { scores: batch.map(() => ({ quality: n / 10, costUsd: 0.01 * (1 + n) })), traces: null };
		},
		makeReflectiveDataset: (_candidate, _batch, components) => Object.fromEntries(components.map((c) => [c, []])),
		async proposeNewTexts(_candidate, _dataset, _components, _signal, h) {
			if (h) hints.push(structuredClone(h));
			pending = notes[call] ?? null;
			return proposals[call++] ?? null;
		},
		takeProposalNotes() {
			const taken = pending;
			pending = null;
			return taken;
		},
	};
	const result = await runGepa({
		adapter,
		callbacks: {
			createCandidate: (input) => {
				created++;
				return { id: `c${created}`, artifactId: `a${created}`, texts: input.texts };
			},
			recordMinibatch: () => {},
			recordPareto: () => {},
			canStartIteration: () => null,
			onEvent: (e) => events.push(e),
		},
		seed,
		seedPareto,
		components: ["body"],
		feedback: cases("f", 3),
		pareto: cases("p", 2),
		patience,
		merge: false,
		rng: mulberry32(1),
		signal: new AbortController().signal,
	});
	return { result, events, hints, created };
}

describe("evolution patterns in the GEPA loop", () => {
	it("rejects a near-duplicate before creating a candidate, then learns from the accepted child", async () => {
		const good: ProposalNotes = { rationale: "Be specific", prediction: { rootCause: "vague", fixes: [1], atRisk: [] } };
		const { result, events, hints, created } = await run([{ body: "V1 BASE!" }, { body: "v5 better rules" }], [null, good], 3);
		const rejected = events.filter((e) => e.type === "rejected");
		expect(rejected[0]).toMatchObject({ reason: expect.stringContaining("near-duplicate") });
		expect(created).toBe(1);
		expect(result.bestId).toBe("c1");
		expect(hints[0]?.patterns).toEqual([]);
		expect(hints[2]?.patterns).toEqual(["Be specific"]);
		const minibatch = events.find((e) => e.type === "minibatch");
		expect(minibatch).toMatchObject({ accepted: true, prediction: { fixesPredicted: 1, fixesHit: 1, unpredictedRegressions: 0 } });
	});

	it("records a rejected change as an anti-pattern and flags a missed prediction", async () => {
		const bad: ProposalNotes = { rationale: "Add more bullets", prediction: { rootCause: "x", fixes: [1], atRisk: [] } };
		const { events, hints } = await run([{ body: "v0 worse" }, null], [bad], 2);
		expect(events.find((e) => e.type === "minibatch")).toMatchObject({ accepted: false, prediction: { fixesHit: 0 } });
		expect(hints[1]?.antiPatterns[0]).toContain("Add more bullets");
		expect(hints[1]?.antiPatterns[0]).toContain("did not materialize");
	});

	it("rejects a reflection that edits a component the optimization does not own", async () => {
		const { events, created } = await run([{ body: "v2 x", other: "y" }], [null], 1);
		expect(created).toBe(0);
		expect(events.find((e) => e.type === "rejected")).toMatchObject({ reason: expect.stringContaining("does not own") });
	});
});
