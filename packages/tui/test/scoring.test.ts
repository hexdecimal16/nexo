import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { scoreRow } from "../../store/test/fixtures.ts";
import { scoreSummary, scoreVerdict } from "../src/app.ts";
import { KEY, until } from "./fake-terminal.ts";
import { FAUX_ROLES, startHarness, submit } from "./helpers.ts";

/** The footer line as last drawn: the last line that starts with a provider/model reference. */
function footer(output: string): string {
	const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w-]+\/[\w.-]+ · /.test(l));
	return lines.at(-1) ?? "";
}

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
			overrides: { ...FAUX_ROLES, providers: { faux: { retryBaseDelayMs: 0, rateLimitBaseDelayMs: 0, maxRetries: 0 } }, scoring: { scorers: [{ kind: "contains", name: "says-done", text: "DONE" }] } },
		});
		h.faux.setResponses([fauxAssistantMessage("not yet"), fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request 400" })]);
		submit(h.terminal, "finish it");
		await until(() => !h.session().running);
		await until(() => expect(h.terminal.output()).toMatch(/✗ s2 continuation failed \[[A-Z_]+\] .*invalid request 400.*kept the previous answer/));
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("switches the footer to the S2 model as soon as an escalation applies, mid-turn", async () => {
		const h = await startHarness({ overrides: { ...FAUX_ROLES, scoring: { scorers: [{ kind: "contains", name: "says-done", text: "DONE" }] } } });
		let release: () => void = () => {};
		h.faux.setResponses([
			fauxAssistantMessage("not yet"),
			() => new Promise((resolve) => (release = () => resolve(fauxAssistantMessage("DONE")))),
		]);
		expect(footer(h.terminal.output())).toMatch(/^faux\/fast · /);
		submit(h.terminal, "finish it");
		await until(() => expect(h.terminal.output()).toContain("↑ escalated to faux/slow"));
		await until(() => expect(footer(h.terminal.output())).toMatch(/^faux\/slow · .*running…$/));
		release();
		await until(() => !h.session().running);
		await until(() => expect(footer(h.terminal.output())).toMatch(/^faux\/slow · /));
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("puts the footer back on S1 when the S2 continuation fails", async () => {
		const h = await startHarness({
			overrides: { ...FAUX_ROLES, providers: { faux: { retryBaseDelayMs: 0, rateLimitBaseDelayMs: 0, maxRetries: 0 } }, scoring: { scorers: [{ kind: "contains", name: "says-done", text: "DONE" }] } },
		});
		h.faux.setResponses([fauxAssistantMessage("not yet"), fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request 400" })]);
		submit(h.terminal, "finish it");
		await until(() => !h.session().running);
		await until(() => expect(h.terminal.output()).toContain("s2 continuation failed"));
		await until(() => expect(footer(h.terminal.output())).toMatch(/^faux\/fast · /));
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("keeps the footer on the root run's model while a subagent runs on another", async () => {
		const h = await startHarness({ overrides: FAUX_ROLES });
		let release: () => void = () => {};
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "a", instruction: "CHILD", model: "s2" }] })]),
			() => new Promise((resolve) => (release = () => resolve(fauxAssistantMessage("child done")))),
			fauxAssistantMessage("parent done"),
		]);
		submit(h.terminal, "delegate");
		await until(() => expect(h.terminal.output()).toContain("CHILD"));
		await until(() => expect(footer(h.terminal.output())).toMatch(/running…$/));
		expect(footer(h.terminal.output())).toMatch(/^faux\/fast · /);
		release();
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("shows the resolved model for a /model role override", async () => {
		const h = await startHarness({ overrides: FAUX_ROLES });
		submit(h.terminal, "/model s2");
		await until(() => expect(footer(h.terminal.output())).toMatch(/^faux\/slow · /));
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("continues on S2 after a turn stopped on S2 unfinished, and says so", async () => {
		const h = await startHarness({
			overrides: {
				...FAUX_ROLES,
				budgets: { perRunUsd: 1, perSessionUsd: 10, perTurnShare: 0.1, estimateOutputTokens: 1 },
				pricingOverrides: { "faux/slow": { input: 0, output: 100_000 } },
				scoring: { scorers: [{ kind: "contains", name: "says-done", text: "DONE" }] },
			},
		});
		let release: () => void = () => {};
		h.faux.setResponses([
			fauxAssistantMessage("not yet"),
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "x" })]),
			() => new Promise((resolve) => (release = () => resolve(fauxAssistantMessage("DONE")))),
		]);
		submit(h.terminal, "finish it");
		await until(() => expect(h.terminal.output()).toContain("s2 continuation failed"));
		await until(() => !h.session().running);
		submit(h.terminal, "please continue");
		await until(() => expect(h.terminal.output()).toContain("continuing on s2 — the previous turn stopped on it"));
		await until(() => expect(footer(h.terminal.output())).toMatch(/^faux\/slow · .*running…$/));
		release();
		await until(() => !h.session().running);
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

	it("shows an auto-allowed line under the tool call", async () => {
		const h = await startHarness({ overrides: { ...FAUX_ROLES, tools: { policy: { bash: "ask" }, autoApprove: "on" } } });
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "touch hi" })]),
			fauxAssistantMessage('{"decision":"allow","reason":"prints text in the workspace"}'),
			fauxAssistantMessage("done"),
		]);
		submit(h.terminal, "say hi");
		await until(() => expect(h.terminal.output()).toContain("auto-allowed: prints text in the workspace"));
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("prefixes a subagent's auto-allowed line with its run label", async () => {
		const h = await startHarness({ overrides: { ...FAUX_ROLES, tools: { policy: { bash: "ask" }, autoApprove: "on" } } });
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "c", instruction: "run echo" }] })]),
			fauxAssistantMessage([fauxToolCall("bash", { command: "touch hi" })]),
			fauxAssistantMessage('{"decision":"allow","reason":"prints text"}'),
			fauxAssistantMessage("child done"),
			fauxAssistantMessage("done"),
		]);
		submit(h.terminal, "delegate");
		await until(() => expect(h.terminal.output()).toMatch(/\[subagent \w{6}\] auto-allowed: prints text/));
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});
});
