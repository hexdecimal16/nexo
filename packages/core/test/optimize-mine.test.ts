import { describe, expect, it, vi } from "vitest";
import { addEvalCase, insertRun, listEvalCases, parseOptimTarget } from "@nexo/store";
import { runRow } from "../../store/test/fixtures.ts";
import { createEngineEnv, mineEvalCases, startOptimization } from "../src/index.ts";
import { optimEnv } from "./optimize-helpers.ts";

const target = parseOptimTarget("skill:ci-fix");
const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function runs(env: ReturnType<typeof optimEnv>, instructions: string[]): void {
	instructions.forEach((instruction, i) => insertRun(env.deps.db, runRow({ status: "succeeded", skill: "ci-fix", instruction, startedAt: recent(100 - i), endedAt: recent(100 - i) })));
}

describe("mineEvalCases", () => {
	it("proposes a cluster of similar instructions with Jaccard when no embedding model is set", async () => {
		const env = optimEnv();
		runs(env, ["fix the failing lint step in ci", "fix the failing lint step in the ci", "please fix the failing lint step in ci", "write release notes"]);
		const result = await mineEvalCases(createEngineEnv(env.deps), target);
		expect(result.measure).toBe("jaccard");
		expect(result.considered).toBe(4);
		expect(result.added).toHaveLength(1);
		expect(result.added[0]).toMatchObject({ status: "proposed", input: "please fix the failing lint step in ci", minedFrom: expect.arrayContaining([expect.any(String)]) });
		expect(result.waiting.map((c) => c.id)).toEqual(result.added.map((c) => c.id));
		const again = await mineEvalCases(createEngineEnv(env.deps), target);
		expect(again.added).toEqual([]);
		expect(again.waiting).toHaveLength(1);
	});

	it("spends nothing when there are fewer runs than minCluster", async () => {
		const env = optimEnv();
		runs(env, ["fix ci", "fix ci"]);
		const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0]));
		const result = await mineEvalCases(createEngineEnv(env.deps), target, { embed });
		expect(embed).not.toHaveBeenCalled();
		expect(result).toMatchObject({ added: [], considered: 2 });
	});

	it("clusters by embedding cosine and suppresses clusters near a dismissed case", async () => {
		const env = optimEnv();
		runs(env, ["alpha one", "alpha two", "alpha three", "beta one", "beta two", "beta three"]);
		const dismissed = addEvalCase(env.deps.db, { target: "skill:ci-fix", input: "beta zero" }, env.deps.redact, new Date().toISOString());
		env.deps.db.prepare("UPDATE eval_cases SET status = 'dismissed' WHERE id = ?").run(dismissed.id);
		const embed = async (texts: readonly string[]) => texts.map((t) => (t.startsWith("alpha") ? [1, 0] : [0, 1]));
		const result = await mineEvalCases(createEngineEnv(env.deps), target, { embed });
		expect(result.measure).toBe("cosine");
		expect(result.added.map((c) => c.input)).toEqual(["alpha three"]);
	});

	it("falls back to Jaccard when the embedding call fails", async () => {
		const env = optimEnv();
		runs(env, ["fix ci lint", "fix ci lint", "fix ci lint"]);
		const result = await mineEvalCases(createEngineEnv(env.deps), target, { embed: async () => Promise.reject(new Error("HTTP 500")) });
		expect(result.measure).toBe("jaccard");
		expect(result.added).toHaveLength(1);
	});

	it("refuses judge_rubric", async () => {
		const env = optimEnv();
		await expect(mineEvalCases(createEngineEnv(env.deps), parseOptimTarget("judge_rubric"))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});
});

describe("optimizations and mined cases", () => {
	it("leave proposed cases out of the eval set and name them in EVAL_SET_TOO_SMALL", async () => {
		const env = optimEnv();
		runs(env, ["fix ci lint", "fix ci lint", "fix ci lint"]);
		await expect(startOptimization(createEngineEnv(env.deps), { target: "skill:ci-fix", budgetUsd: 1 })).rejects.toMatchObject({
			code: "EVAL_SET_TOO_SMALL",
			context: expect.objectContaining({ proposedCases: [expect.any(String)] }),
		});
		expect(listEvalCases(env.deps.db, "skill:ci-fix").map((c) => c.status)).toEqual(["proposed"]);
	});
});
