import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { scoreRow } from "../../store/test/fixtures.ts";
import { scoreSummary, scoreVerdict } from "../src/app.ts";
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

	it("shows a failed S2 continuation in the chat", async () => {
		const h = await startHarness({
			overrides: { ...FAUX_ROLES, providers: { faux: { retryBaseDelayMs: 0, maxRetries: 0 } }, scoring: { scorers: [{ kind: "contains", name: "says-done", text: "DONE" }] } },
		});
		h.faux.setResponses([fauxAssistantMessage("not yet"), fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request 400" })]);
		submit(h.terminal, "finish it");
		await until(() => !h.session().running);
		await until(() => expect(h.terminal.output()).toMatch(/✗ s2 continuation failed \[[A-Z_]+\] .*invalid request 400.*kept the previous answer/));
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("summarizes a turn's scores for the footer", () => {
		expect(scoreSummary({})).toBeNull();
		expect(scoreSummary({ scores: [scoreRow("r", { value: 0.5 }), scoreRow("r", { value: 1 })] })).toBe("score 0.75 ✓");
		expect(scoreSummary({ scores: [scoreRow("r", { value: 0.5, passed: false })] })).toBe("score 0.50 ✗");
		expect(scoreSummary({ scores: [scoreRow("r", { status: "failed", value: null, passed: null })] })).toBe("score failed");
	});

	it("shows a neutral mark when no scorer gave a pass/fail verdict", () => {
		expect(scoreSummary({ scores: [scoreRow("r", { value: 0.5, passed: null })] })).toBe("score 0.50 –");
		expect(scoreSummary({ scores: [scoreRow("r", { value: 0.5, passed: null }), scoreRow("r", { value: 1, passed: true })] })).toBe("score 0.75 ✓");
		expect(scoreSummary({ scores: [scoreRow("r", { value: 0.5, passed: null }), scoreRow("r", { value: 0, passed: false })] })).toBe("score 0.25 ✗");
	});

	it("marks each chat score line pass, fail, neutral or failed", () => {
		const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
		expect(plain(scoreVerdict({ status: "ok", value: 0.8, passed: true }))).toBe("0.80 ✓");
		expect(plain(scoreVerdict({ status: "ok", value: 0.4, passed: false }))).toBe("0.40 ✗");
		expect(plain(scoreVerdict({ status: "ok", value: 0.5, passed: null }))).toBe("0.50 –");
		expect(plain(scoreVerdict({ status: "failed", value: null, passed: null }))).toBe("failed");
	});

	it("counts failed scorers next to the mean of those that answered", () => {
		const failed = scoreRow("r", { status: "failed", value: null, passed: null });
		expect(scoreSummary({ scores: [scoreRow("r", { value: 1 }), failed] })).toBe("score 1.00 ✓ · 1 failed");
		expect(scoreSummary({ scores: [scoreRow("r", { value: 0.5, passed: false }), failed, failed] })).toBe("score 0.50 ✗ · 2 failed");
		expect(scoreSummary({ scores: [failed, failed] })).toBe("score failed");
	});
});
