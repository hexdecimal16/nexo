import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { scoreRow } from "../../store/test/fixtures.ts";
import { scoreSummary } from "../src/app.ts";
import { KEY, until } from "./fake-terminal.ts";
import { FAUX_ROLES, startHarness, submit } from "./helpers.ts";

describe("scores and escalations in the chat", () => {
	it("shows the escalation, each score, and the latest score in the footer", async () => {
		const h = await startHarness({ overrides: { ...FAUX_ROLES, scoring: { scorers: [{ kind: "contains", name: "says-done", text: "DONE" }] } } });
		h.faux.setResponses([fauxAssistantMessage("not yet"), fauxAssistantMessage("DONE")]);
		submit(h.terminal, "finish it");
		await until(() => expect(h.terminal.output()).toContain("↑ escalated to faux/slow — verify_fail: deterministic scorer failed: says-done"));
		await until(() => !h.session().running);
		await until(() => {
			const out = h.terminal.output();
			expect(out).toContain("score says-done: 0.00 ✗");
			expect(out).toContain("score says-done: 1.00 ✓");
			expect(out).toMatch(/turn \$\d+\.\d{2} · score 1\.00 ✓ · session/);
		});
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("summarizes a turn's scores for the footer", () => {
		expect(scoreSummary({})).toBeNull();
		expect(scoreSummary({ scores: [scoreRow("r", { value: 0.5 }), scoreRow("r", { value: 1 })] })).toBe("score 0.75 ✓");
		expect(scoreSummary({ scores: [scoreRow("r", { value: 0.5, passed: false })] })).toBe("score 0.50 ✗");
		expect(scoreSummary({ scores: [scoreRow("r", { status: "failed", value: null, passed: null })] })).toBe("score failed");
	});
});
