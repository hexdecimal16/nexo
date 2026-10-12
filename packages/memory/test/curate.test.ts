import { describe, expect, it } from "vitest";
import {
	addMemory,
	addPlaybookItem,
	getActiveArtifact,
	getEmbeddings,
	getMemory,
	listMemories,
	listPlaybookItems,
	openDb,
	putEmbedding,
	tagPlaybookItem,
} from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { applyCuratorDelta, type CurationInput, curationChanged } from "../src/index.ts";

const redact = createRedactor();
const NOW = "2026-10-12T00:00:00.000Z";

function base(overrides: Partial<CurationInput> = {}): CurationInput {
	return { runId: "r1", delta: { memory: [], playbook: [] }, tags: [], skills: ["ci"], maxPlaybookItems: 50, redact, nowIso: NOW, ...overrides };
}

describe("applyCuratorDelta", () => {
	it("adds, supersedes and no-ops memories as the curator, clamping importance and redacting", () => {
		const db = openDb(":memory:");
		const old = addMemory(db, { scope: "user", type: "preference", content: "Prefers yarn", importance: 0.5, source: "ace" }, redact, NOW);
		const result = applyCuratorDelta(
			db,
			base({
				delta: {
					memory: [
						{ op: "add", type: "fact", scope: "user", content: "Deploy key is sk-ant-abcdefghijklmnopqrstuvwx", importance: 1 },
						{ op: "supersede", id: old.id, content: "Prefers pnpm" },
						{ op: "noop" },
					],
					playbook: [],
				},
			}),
		);
		expect(result.memoriesAdded).toHaveLength(1);
		expect(result.noops).toBe(1);
		const added = getMemory(db, result.memoriesAdded[0] ?? "");
		expect(added).toMatchObject({ source: "ace", importance: 0.7, content: "Deploy key is [REDACTED]", sourceRunId: "r1" });
		expect(getMemory(db, old.id)?.supersededBy).toBe(result.memoriesSuperseded[0]?.to);
		expect(listMemories(db).map((m) => m.content).sort()).toEqual(["Deploy key is [REDACTED]", "Prefers pnpm"]);
		expect(curationChanged(result)).toBe(true);
	});

	it("rejects curator ops on human items and applies the rest of the batch", () => {
		const db = openDb(":memory:");
		const human = addMemory(db, { scope: "user", type: "lesson", content: "Never deploy on Fridays", importance: 1, source: "human" }, redact, NOW);
		const user = addMemory(db, { scope: "global", type: "fact", content: "Prod is eu-west-1", importance: 0.9, source: "user" }, redact, NOW);
		addPlaybookItem(db, { skill: "ci", content: "Ask before force-pushing", source: "human" }, redact, NOW);
		const result = applyCuratorDelta(
			db,
			base({
				delta: {
					memory: [
						{ op: "supersede", id: human.id, content: "Deploy any day" },
						{ op: "update", id: user.id, content: "Prod is us-east-1" },
						{ op: "update", id: "missing", content: "x" },
						{ op: "add", type: "lesson", scope: "user", content: "Check the release calendar first", importance: 0.5 },
					],
					playbook: [
						{ op: "retire", skill: "ci", key: "k001" },
						{ op: "update", skill: "ci", key: "k001", content: "Force-push freely" },
						{ op: "add", skill: "ci", content: "Run lint before tests" },
					],
				},
			}),
		);
		expect(result.rejected.map((r) => [r.list, r.index, r.code])).toEqual([
			["memory", 0, "FORBIDDEN"],
			["memory", 1, "FORBIDDEN"],
			["memory", 2, "NOT_FOUND"],
			["playbook", 0, "FORBIDDEN"],
			["playbook", 1, "FORBIDDEN"],
		]);
		expect(getMemory(db, human.id)).toMatchObject({ supersededBy: null, retiredAt: null, content: "Never deploy on Fridays" });
		expect(getMemory(db, user.id)?.supersededBy).toBeNull();
		expect(listPlaybookItems(db, "ci").map((i) => [i.key, i.source, i.content])).toEqual([
			["k001", "human", "Ask before force-pushing"],
			["k002", "ace", "Run lint before tests"],
		]);
		expect(result.memoriesAdded).toHaveLength(1);
	});

	it("rejects playbook ops, tags and skill scopes for skills the run did not use", () => {
		const db = openDb(":memory:");
		addPlaybookItem(db, { skill: "other", content: "Keep", source: "ace" }, redact, NOW);
		const result = applyCuratorDelta(
			db,
			base({
				delta: { memory: [{ op: "add", type: "fact", scope: "skill:other", content: "x", importance: 0.5 }], playbook: [{ op: "retire", skill: "other", key: "k001" }] },
				tags: [{ skill: "other", key: "k001", tag: "harmful" }],
			}),
		);
		expect(result.rejected.map((r) => [r.list, r.code])).toEqual([
			["memory", "INVALID_REQUEST"],
			["playbook", "INVALID_REQUEST"],
			["tags", "INVALID_REQUEST"],
		]);
		expect(listPlaybookItems(db, "other")[0]).toMatchObject({ status: "active", harmful: 0 });
		expect(curationChanged(result)).toBe(false);
	});

	it("skips duplicates by cosine with embeddings and by Jaccard without, and stores new vectors", () => {
		const db = openDb(":memory:");
		const m = addMemory(db, { scope: "user", type: "fact", content: "The API lives at api.example.com", importance: 0.5, source: "ace" }, redact, NOW);
		putEmbedding(db, m.id, "openai/e", [1, 0], NOW);
		addPlaybookItem(db, { skill: "ci", content: "Run lint before the tests", source: "ace" }, redact, NOW);
		const vectors = new Map<string, number[]>([
			["Endpoint: api.example.com", [0.99, 0.05]],
			["Releases happen on Tuesdays", [0, 1]],
		]);
		const result = applyCuratorDelta(
			db,
			base({
				embeddingModel: "openai/e",
				vectors,
				delta: {
					memory: [
						{ op: "add", type: "fact", scope: "user", content: "Endpoint: api.example.com", importance: 0.5 },
						{ op: "add", type: "fact", scope: "user", content: "Releases happen on Tuesdays", importance: 0.5 },
					],
					playbook: [{ op: "add", skill: "ci", content: "run lint before the tests." }],
				},
			}),
		);
		expect(result.duplicates).toBe(2);
		expect(result.memoriesAdded).toHaveLength(1);
		expect([...(getEmbeddings(db, result.memoriesAdded, "openai/e").values().next().value ?? [])]).toEqual([0, 1]);
		expect(listPlaybookItems(db, "ci")).toHaveLength(1);
	});

	it("tags counters, prunes to the cap without touching human items and publishes one ace version per changed skill", () => {
		const db = openDb(":memory:");
		addPlaybookItem(db, { skill: "ci", content: "Human rule one", source: "human" }, redact, NOW);
		addPlaybookItem(db, { skill: "ci", content: "Old weak tip", source: "ace" }, redact, NOW);
		tagPlaybookItem(db, "ci", "k002", "harmful", null, NOW);
		const result = applyCuratorDelta(
			db,
			base({
				maxPlaybookItems: 2,
				tags: [{ skill: "ci", key: "k001", tag: "helpful" }],
				delta: { memory: [], playbook: [{ op: "add", skill: "ci", content: "Cache node_modules between jobs" }] },
			}),
		);
		expect(result.tagged).toBe(1);
		expect(result.itemsPruned).toEqual([{ skill: "ci", key: "k002" }]);
		expect(listPlaybookItems(db, "ci").map((i) => [i.key, i.helpful])).toEqual([
			["k001", 1],
			["k003", 0],
		]);
		expect(result.playbookVersions).toEqual([{ skill: "ci", artifactId: expect.any(String), version: 1 }]);
		expect(getActiveArtifact(db, "playbook", "ci")).toMatchObject({ origin: "ace", content: "- [k001] Human rule one\n- [k003] Cache node_modules between jobs" });
	});

	it("rolls the whole batch back on an unexpected error", () => {
		const db = openDb(":memory:");
		const throwing = { ...base(), redact: ((v: unknown) => {
			if (typeof v === "string" && v.includes("boom")) throw new Error("redactor crashed");
			return v;
		}) as never };
		expect(() =>
			applyCuratorDelta(db, {
				...throwing,
				delta: {
					memory: [
						{ op: "add", type: "fact", scope: "user", content: "fine", importance: 0.5 },
						{ op: "add", type: "fact", scope: "user", content: "boom", importance: 0.5 },
					],
					playbook: [],
				},
			}),
		).toThrow("redactor crashed");
		expect(listMemories(db)).toEqual([]);
	});
});
