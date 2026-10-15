import { describe, expect, it } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import { createApprovalPrompter } from "../src/approvals.ts";

function host() {
	const shown: Component[] = [];
	return { shown, show: (box: Component) => (shown.push(box), () => shown.splice(shown.indexOf(box), 1)) };
}
const render = (box: Component) => box.render(80).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
const UP = "\u001b[A";

describe("approval box", () => {
	it("shows the note and three options with Deny preselected; Always allow answers always", async () => {
		const h = host();
		let t = 0;
		const prompter = createApprovalPrompter(h, { now: () => t, guardMs: 400 });
		const answer = prompter.approve({ question: "Allow bash: npm run test?", note: "auto: watch mode", alwaysLabel: "Always allow `npm run test …` this session" });
		await Promise.resolve();
		const box = h.shown[0] as Component & { handleInput(d: string): void };
		const text = render(box);
		expect(text).toContain("auto: watch mode");
		expect(text).toMatch(/Allow once[\s\S]*Always allow `npm run test …` this session[\s\S]*→ Deny/);
		box.handleInput("\r"); // ignored: inside the guard time
		t = 500;
		box.handleInput(UP);
		box.handleInput("\r");
		expect(await answer).toBe("always");
		expect(h.shown).toHaveLength(0);
	});

	it("redacts the always label like the question and the note", async () => {
		const h = host();
		const prompter = createApprovalPrompter(h, { redact: (t) => t.replace(/SECRET-\d+/g, "[redacted]") });
		void prompter.approve({ question: "Allow bash: SECRET-1?", note: "auto: SECRET-2", alwaysLabel: "Always allow `echo SECRET-3 …` this session" });
		await Promise.resolve();
		const text = render(h.shown[0] as Component);
		expect(text).not.toContain("SECRET");
		expect(text).toContain("Always allow `echo [redacted] …` this session");
	});

	it("has two options without alwaysLabel, and settled requests skip the question", async () => {
		const h = host();
		const prompter = createApprovalPrompter(h, { now: () => 1000, guardMs: 0 });
		let settled = false;
		const first = prompter.approve({ question: "Allow bash: npm run test?", alwaysLabel: "Always allow `npm run test …` this session" });
		const second = prompter.approve({ question: "Allow bash: npm run test -t x?", settled: () => settled });
		await Promise.resolve();
		const box = h.shown[0] as Component & { handleInput(d: string): void };
		box.handleInput(UP);
		box.handleInput("\r");
		settled = true; // as if "Always allow" added a matching rule
		expect(await first).toBe("always");
		expect(await second).toBe("once");
		expect(h.shown).toHaveLength(0);
		const third = prompter.approve({ question: "Allow bash: ls?" });
		await Promise.resolve();
		expect(render(h.shown[0] as Component)).not.toContain("Always allow");
		(h.shown[0] as Component & { handleInput(d: string): void }).handleInput("\r");
		expect(await third).toBe("deny");
	});
});
