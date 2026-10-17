import { describe, expect, it } from "vitest";
import { type GepaAdapter, type GepaEvent, mulberry32, type ProposalNotes, runGepa } from "../src/index.ts";

const num = (text: string | undefined) => Number(/v([0-9]+)/.exec(text ?? "")?.[1] ?? 0);
const ids = (prefix: string, n: number) =>
	Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, input: `${prefix} ${i}`, skill: null, expected: null, referenceFeedback: null, sourceRunId: null }));
const notes: ProposalNotes = { rationale: "r", prediction: { rootCause: "x", fixes: [1], atRisk: [2] } };

async function run(embed: GepaAdapter["embed"] | undefined) {
	const events: GepaEvent[] = [];
	const recorded: { id: string; rationale: string; fixesHit: number | null }[] = [];
	let pending: ProposalNotes | null = notes;
	let created = 0;
	let calls = 0;
	const adapter: GepaAdapter = {
		async evaluate(batch, candidate) {
			const n = num(candidate.texts.body);
			return { scores: batch.map(() => ({ quality: n / 10, costUsd: 0.01 })), traces: null };
		},
		makeReflectiveDataset: (_c, _b, components) => Object.fromEntries(components.map((c) => [c, []])),
		async proposeNewTexts() {
			calls++;
			return calls === 1 ? { body: "v5 rewritten rules" } : null;
		},
		takeProposalNotes() {
			const taken = pending;
			pending = null;
			return taken;
		},
		...(embed ? { embed } : {}),
	};
	await runGepa({
		adapter,
		callbacks: {
			createCandidate: (input) => {
				created++;
				return { id: `c${created}`, artifactId: `a${created}`, texts: input.texts };
			},
			recordMinibatch: () => {},
			recordPareto: () => {},
			recordNotes: (id, n) => {
				recorded.push({ id, rationale: n.rationale, fixesHit: n.prediction?.fixesHit ?? null });
			},
			canStartIteration: () => null,
			onEvent: (e) => events.push(e),
		},
		seed: { id: "seed", artifactId: "a0", texts: { body: "v1 base" } },
		seedPareto: { p0: { quality: 0.1, costUsd: 0.01 }, p1: { quality: 0.1, costUsd: 0.01 } },
		components: ["body"],
		feedback: ids("f", 3),
		pareto: ids("p", 2),
		patience: 1,
		merge: false,
		rng: mulberry32(1),
		signal: new AbortController().signal,
	});
	return { events, recorded, created };
}

describe("embedding novelty filter and recorded notes", () => {
	it("rejects a text whose embedding is almost the same as a pool text", async () => {
		const { events, created, recorded } = await run(async (texts) => texts.map((t) => (t.startsWith("v1") ? [1, 0] : [1, 0.01])));
		expect(created).toBe(0);
		expect(recorded).toEqual([]);
		expect(events.find((e) => e.type === "rejected")).toMatchObject({ reason: expect.stringContaining("near-duplicate") });
	});

	it("keeps a text with a distant embedding and records its rationale and checked prediction", async () => {
		const { created, recorded } = await run(async (texts) => texts.map((t) => (t.startsWith("v1") ? [1, 0] : [0, 1])));
		expect(created).toBe(1);
		expect(recorded).toEqual([{ id: "c1", rationale: "r", fixesHit: 1 }]);
	});

	it("falls back to word overlap when the embedder returns nothing", async () => {
		const { created } = await run(async () => null);
		expect(created).toBe(1);
	});
});
