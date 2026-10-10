import { describe, expect, it } from "vitest";
import type { NexoError } from "@nexo/telemetry";
import { parseModelRef, resolveModel, type RoleModel } from "../src/index.ts";

const roles: Record<"s1" | "s2", RoleModel> = {
	s1: { provider: "faux", id: "fast", effort: "low" },
	s2: { provider: "faux", id: "slow", effort: "high" },
};

describe("parseModelRef", () => {
	it("resolves roles and provider/id refs, keeping slashes inside ids", () => {
		expect(parseModelRef("s2", roles)).toEqual({ provider: "faux", id: "slow", role: "s2" });
		expect(parseModelRef("openrouter/anthropic/claude-x", roles)).toEqual({
			provider: "openrouter",
			id: "anthropic/claude-x",
			role: null,
		});
		expect(parseModelRef("faux/fast", roles).role).toBe("s1");
	});

	it("rejects refs that are neither a role nor provider/id", () => {
		expect(() => parseModelRef("gpt", roles)).toThrow(/provider\/model-id/);
	});
});

describe("resolveModel precedence", () => {
	const base = { roles, remainingFraction: 1 };

	it("defaults to s1 with its role effort", () => {
		expect(resolveModel(base)).toMatchObject({ id: "fast", role: "s1", effort: "low", source: "default", effortSource: "default" });
	});

	it("skill default beats global default", () => {
		const r = resolveModel({ ...base, skill: { model: "s2", effort: "medium", allowed: ["s1", "s2"] } });
		expect(r).toMatchObject({ id: "slow", source: "skill", effort: "medium", effortSource: "skill" });
	});

	it("parent beats skill", () => {
		const r = resolveModel({ ...base, parent: { model: "s1" }, skill: { model: "s2", allowed: ["s1", "s2"] } });
		expect(r).toMatchObject({ id: "fast", source: "parent" });
	});

	it("user beats parent and is not restricted by the skill allow-list", () => {
		const r = resolveModel({ ...base, user: { model: "other/x" }, parent: { model: "s1" }, skill: { allowed: ["s1"] } });
		expect(r).toMatchObject({ provider: "other", id: "x", source: "user", role: null, effort: "off" });
	});

	it("rejects a parent model outside the skill allow-list with retryable MODEL_NOT_ALLOWED", () => {
		try {
			resolveModel({ ...base, parent: { model: "s2" }, skill: { allowed: ["s1"] } });
			expect.unreachable();
		} catch (err) {
			expect((err as NexoError).code).toBe("MODEL_NOT_ALLOWED");
			expect((err as NexoError).retryable).toBe(true);
		}
	});

	it("accepts a parent provider/id that equals an allowed role's model", () => {
		expect(resolveModel({ ...base, parent: { model: "faux/slow" }, skill: { allowed: ["s2"] } }).id).toBe("slow");
	});

	it("clamps a parent choice to s1 when the remaining budget is below 20%", () => {
		const r = resolveModel({ ...base, remainingFraction: 0.1, parent: { model: "s2", effort: "max" } });
		expect(r).toMatchObject({ id: "fast", source: "router", effort: "low", effortSource: "router" });
	});

	it("resolves effort independently of the model source", () => {
		const r = resolveModel({ ...base, parent: { effort: "high" }, skill: { model: "s2", allowed: ["s1", "s2"] } });
		expect(r).toMatchObject({ id: "slow", source: "skill", effort: "high", effortSource: "parent" });
	});
});
