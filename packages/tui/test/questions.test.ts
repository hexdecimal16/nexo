import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createApprovalPrompter } from "../src/approvals.ts";

function host() {
	const shown: Component[] = [];
	return { shown, show: (box: Component) => (shown.push(box), () => shown.splice(shown.indexOf(box), 1)) };
}
type Box = Component & { handleInput(d: string): void };
const render = (box: Component) => box.render(80).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
const DOWN = "\u001b[B";
const options = [{ label: "Refine" }, { label: "Redesign", description: "replace the look" }, { label: "Audit" }];

describe("question box", () => {
	it("answers single-select, multi-select and typed questions in order", async () => {
		const h = host();
		const prompter = createApprovalPrompter(h, { guardMs: 0 });
		const answer = prompter.ask?.({
			questions: [
				{ question: "Which pass?", header: "Scope", options },
				{ question: "Which areas?", options, multiSelect: true },
				{ question: "Anything else?", options: options.slice(0, 2) },
			],
		});
		await Promise.resolve();
		const box = h.shown[0] as Box;
		expect(render(box)).toMatch(/Question 1\/3 · Scope[\s\S]*Which pass\?[\s\S]*replace the look[\s\S]*Type your own answer/);
		box.handleInput(DOWN);
		box.handleInput("\r");
		box.handleInput(" ");
		box.handleInput(DOWN);
		box.handleInput(DOWN);
		box.handleInput(" ");
		box.handleInput("\r");
		box.handleInput(DOWN);
		box.handleInput(DOWN);
		box.handleInput("\r");
		for (const ch of "dark mode") box.handleInput(ch);
		box.handleInput("\r");
		expect(await answer).toEqual({
			answers: [
				{ question: "Which pass?", selected: ["Redesign"] },
				{ question: "Which areas?", selected: ["Refine", "Audit"] },
				{ question: "Anything else?", selected: [], text: "dark mode" },
			],
		});
		expect(h.shown).toHaveLength(0);
	});

	it("esc declines, an abort closes the box, and input inside the guard is dropped", async () => {
		const h = host();
		let t = 0;
		const prompter = createApprovalPrompter(h, { guardMs: 400, now: () => t });
		const declined = prompter.ask?.({ questions: [{ question: "Q?", options }] });
		await Promise.resolve();
		const box = h.shown[0] as Box;
		box.handleInput("\r");
		t = 500;
		box.handleInput("\u001b");
		expect(await declined).toBeNull();

		const abort = new AbortController();
		const aborted = prompter.ask?.({ questions: [{ question: "Q?", options }] }, abort.signal);
		await new Promise((r) => setTimeout(r, 0));
		expect(h.shown).toHaveLength(1);
		abort.abort();
		expect(await aborted).toBeNull();
		expect(h.shown).toHaveLength(0);
	});
});
