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
});
