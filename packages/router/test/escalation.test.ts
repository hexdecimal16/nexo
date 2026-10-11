import { describe, expect, it } from "vitest";
import { NexoError } from "@nexo/telemetry";
import { DEFAULT_ROUTER_POLICY, endOfRunSignals, escalationBlock, isModelAllowed, parseRouterPolicy, type RouterPolicy, TriggerMonitor } from "../src/index.ts";

function policy(triggers: Partial<RouterPolicy["triggers"]> = {}): RouterPolicy {
	return { triggers: { ...DEFAULT_ROUTER_POLICY.triggers, ...triggers } };
}

function configError(fn: () => unknown): NexoError {
	try {
		fn();
	} catch (error) {
		if (error instanceof NexoError) return error;
		throw error;
	}
	throw new Error("expected a NexoError");
}

describe("parseRouterPolicy", () => {
	it("fills left-out triggers and fields with the defaults", () => {
		expect(parseRouterPolicy("{}", "t")).toEqual(DEFAULT_ROUTER_POLICY);
		const p = parseRouterPolicy('{"triggers":{"tool_failures":{"consecutive":4},"self_check":{"enabled":true}}}', "t");
		expect(p.triggers.tool_failures).toEqual({ enabled: true, consecutive: 4 });
		expect(p.triggers.self_check).toEqual({ enabled: true, threshold: 0.6 });
		expect(p.triggers.judge_low).toEqual(DEFAULT_ROUTER_POLICY.triggers.judge_low);
	});

	it("rejects invalid JSON, out-of-range values, wrong types and unknown triggers with CONFIG_INVALID naming the path", () => {
		expect(configError(() => parseRouterPolicy("{", "policy.json"))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("policy.json is not valid JSON") });
		expect(configError(() => parseRouterPolicy('{"triggers":{"judge_low":{"threshold":2}}}', "p")).message).toContain("/triggers/judge_low/threshold");
		expect(configError(() => parseRouterPolicy('{"triggers":{"stagnation":{"turns":0}}}', "p")).message).toContain("/triggers/stagnation/turns");
		expect(configError(() => parseRouterPolicy('{"triggers":{"verify_fail":true}}', "p")).message).toContain("/triggers/verify_fail");
		expect(configError(() => parseRouterPolicy('{"triggers":{"tool_failure":{"enabled":true}}}', "p")).message).toContain("/triggers/tool_failure is not a recognized setting");
		expect(configError(() => parseRouterPolicy('{"triggers":{"tool_failures":{"consecutive":-1}}}', "p")).message).toContain("/triggers/tool_failures/consecutive");
		expect(configError(() => parseRouterPolicy('{"triggers":{"tool_failures":{"consecutive":1.5}}}', "p")).message).toContain("/triggers/tool_failures/consecutive");
		expect(configError(() => parseRouterPolicy('{"triggers":{"self_check":{"threshold":-0.1}}}', "p")).message).toContain("/triggers/self_check/threshold");
		expect(configError(() => parseRouterPolicy('{"triggers":{"tool_failures":{"consecutiv":3}}}', "p")).message).toContain("/triggers/tool_failures/consecutiv is not a recognized setting");
		expect(configError(() => parseRouterPolicy("[]", "p")).code).toBe("CONFIG_INVALID");
	});
});

describe("TriggerMonitor", () => {
	it("fires tool_failures after N consecutive errors and resets on success", () => {
		const m = new TriggerMonitor(policy());
		expect(m.toolResult(true)).toBeNull();
		expect(m.toolResult(false)).toBeNull();
		expect(m.toolResult(true)).toBeNull();
		expect(m.toolResult(true)).toEqual({ trigger: "tool_failures", reason: "2 consecutive tool calls failed" });
		expect(m.toolResult(true)).toBeNull();
	});

	it("fires stagnation after M turns with no new tool result, ignoring turns without tools", () => {
		const m = new TriggerMonitor(policy({ stagnation: { enabled: true, turns: 2 } }));
		expect(m.turnEnd(["read a -> x"])).toBeNull();
		expect(m.turnEnd(["read a -> x"])).toBeNull();
		expect(m.turnEnd([])).toBeNull();
		expect(m.turnEnd(["read a -> x"])).toEqual({ trigger: "stagnation", reason: "2 turns in a row produced no new tool result" });
		expect(m.turnEnd(["read a -> x", "read b -> y"])).toBeNull();
	});

	it("fires skill_hint only for skills that set nexo-model s2", () => {
		const m = new TriggerMonitor(policy());
		expect(m.skillLoaded("easy", undefined)).toBeNull();
		expect(m.skillLoaded("custom", "openai/gpt-x")).toBeNull();
		expect(m.skillLoaded("hard", "s2")).toEqual({ trigger: "skill_hint", reason: 'skill "hard" sets nexo-model: s2' });
	});

	it("never fires disabled triggers", () => {
		const off = policy({ tool_failures: { enabled: false, consecutive: 1 }, stagnation: { enabled: false, turns: 1 }, skill_hint: { enabled: false } });
		const m = new TriggerMonitor(off);
		expect([m.toolResult(true), m.turnEnd(["k"]), m.turnEnd(["k"]), m.skillLoaded("hard", "s2")]).toEqual([null, null, null, null]);
	});
});

describe("endOfRunSignals", () => {
	it("fires self_check, verify_fail and judge_low below their thresholds, in spec order", () => {
		const p = policy({ self_check: { enabled: true, threshold: 0.6 } });
		expect(endOfRunSignals(p, { selfCheck: 0.4, failedDeterministic: ["tests"], judgeScore: 0.5 }).map((s) => s.trigger)).toEqual(["self_check", "verify_fail", "judge_low"]);
		expect(endOfRunSignals(p, { selfCheck: 0.6, failedDeterministic: [], judgeScore: 0.6 })).toEqual([]);
		expect(endOfRunSignals(p, { selfCheck: null, failedDeterministic: [], judgeScore: null })).toEqual([]);
		expect(endOfRunSignals(DEFAULT_ROUTER_POLICY, { selfCheck: 0, failedDeterministic: [], judgeScore: null })).toEqual([]);
	});
});

describe("escalationBlock", () => {
	const open = { escalations: 0, maxEscalations: 1, spentFraction: 0.5, cutoff: 0.8, skillAllows: true, modelAllowed: true, userPinned: false };
	it("allows an escalation within limits and names the first reason to block one", () => {
		expect(escalationBlock(open)).toBeNull();
		expect(escalationBlock({ ...open, spentFraction: 0.8 })).toBeNull();
		expect(escalationBlock({ ...open, spentFraction: 0.81 })).toBe("budget_cutoff");
		expect(escalationBlock({ ...open, escalations: 1 })).toBe("max_escalations");
		expect(escalationBlock({ ...open, userPinned: true })).toBe("user_model");
		expect(escalationBlock({ ...open, modelAllowed: false, userPinned: true })).toBe("model_not_allowed");
		expect(escalationBlock({ ...open, skillAllows: false, modelAllowed: false, escalations: 5 })).toBe("skill_disabled");
	});
});

describe("isModelAllowed", () => {
	const roles = { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } };
	it("matches roles and provider/id entries of nexo-model-allowed, either way round", () => {
		expect(isModelAllowed("s2", ["s1", "s2"], roles)).toBe(true);
		expect(isModelAllowed("s2", ["s1"], roles)).toBe(false);
		expect(isModelAllowed("s2", ["faux/slow"], roles)).toBe(true);
		expect(isModelAllowed("faux/slow", ["s2"], roles)).toBe(true);
		expect(isModelAllowed("s2", ["not a ref"], roles)).toBe(false);
	});
});
