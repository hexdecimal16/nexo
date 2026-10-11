import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { dispatcher } from "../../core/test/helpers.ts";
import { KEY, until } from "./fake-terminal.ts";
import { makeHarness, startHarness, submit } from "./helpers.ts";

describe("chat screen", () => {
	it("echoes the user message and streams assistant markdown", async () => {
		const h = await startHarness();
		h.faux.setResponses([fauxAssistantMessage("Hello **world**, from nexo.")]);
		submit(h.terminal, "say hello");
		await until(() => expect(h.terminal.output()).toContain("Hello world, from nexo."));
		expect(h.terminal.output()).toContain("say hello");
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
	});

	it("renders text deltas as they arrive, before the turn ends", async () => {
		const h = await startHarness();
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		// The first reply streams a tool call; the second waits on the gate so the first text is visible mid-turn.
		h.faux.setResponses([
			fauxAssistantMessage([fauxText("first part "), fauxToolCall("read", { path: "nothing.txt" })]),
			async () => {
				await gate;
				return fauxAssistantMessage("second part");
			},
		]);
		submit(h.terminal, "go");
		await until(() => expect(h.terminal.output()).toContain("first part"));
		expect(h.session().running).toBe(true);
		expect(h.terminal.output()).not.toContain("second part");
		release();
		await until(() => expect(h.terminal.output()).toContain("second part"));
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("shows a tool line running, then ✓ with a preview, and ✗ for a failed tool", async () => {
		const h = await startHarness();
		const { writeFileSync } = await import("node:fs");
		writeFileSync(`${h.cwd}/notes.txt`, "line one\nline two\n");
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })]),
			async () => {
				await gate;
				return fauxAssistantMessage("done reading");
			},
		]);
		submit(h.terminal, "read notes");
		await until(() => expect(h.terminal.output()).toMatch(/✓ read\(notes\.txt\)/));
		expect(h.terminal.output()).toContain("line one");
		await until(() => expect(h.terminal.output()).toMatch(/✗ read\(missing\.txt\)/));
		release();
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("escapes control characters in tool arguments and results", async () => {
		const h = await startHarness();
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "evil\x1b[31m.txt" })]), fauxAssistantMessage("ok")]);
		submit(h.terminal, "read evil");
		await until(() => expect(h.terminal.output()).toContain("evil\\x1b[31m.txt"));
		expect(h.terminal.raw()).not.toContain("evil\x1b[31m");
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("asks for approval in an overlay and returns Allow or Deny to the policy", async () => {
		const h = await startHarness();
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo approved-run" })]),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo denied-run" })]),
			fauxAssistantMessage("finished"),
		]);
		submit(h.terminal, "run things");
		await until(() => expect(h.terminal.output()).toContain("Allow bash: echo approved-run?"));
		expect(h.terminal.output()).toContain("Allow once");
		// The tool line spins while the approval is pending.
		expect(h.terminal.output()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] bash\(echo approved-run\)/);
		expect(h.terminal.output()).toContain("Deny");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toMatch(/✓ bash\(echo approved-run\)/));
		await until(() => expect(h.terminal.output()).toContain("Allow bash: echo denied-run?"));
		h.terminal.send(KEY.down);
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toMatch(/✗ bash\(echo denied-run\)/));
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("shows model, effort, turn and session cost, cap and context in the footer", async () => {
		const h = await startHarness({ overrides: { models: { s1: { provider: "faux", id: "slow" }, s2: { provider: "faux", id: "slow" } }, providers: { faux: { retryBaseDelayMs: 0 } }, budgets: { perSessionUsd: 5 } } });
		expect(h.terminal.output()).toContain("faux/slow");
		expect(h.terminal.output()).toContain("$0.00/$5.00");
		h.faux.setResponses([fauxAssistantMessage("x".repeat(400))]);
		submit(h.terminal, "spend a little");
		await until(() => !h.session().running && h.session().costUsd > 0);
		const session = h.session();
		const turn = `turn $${session.costUsd.toFixed(2)}`;
		await until(() => {
			const out = h.terminal.output();
			expect(out).toContain(turn);
			expect(out).toContain(`session $${session.costUsd.toFixed(2)}/$5.00`);
			expect(out).toMatch(/ctx \d+%/);
		});
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("aborts the running turn on Ctrl-C and reports it, then keeps the session usable", async () => {
		const h = await startHarness();
		let sawAbort = false;
		h.faux.setResponses([
			async (_ctx, opts) =>
				new Promise((resolve) => {
					opts?.signal?.addEventListener("abort", () => {
						sawAbort = true;
						resolve(fauxAssistantMessage("late", { stopReason: "aborted" }));
					});
				}),
			fauxAssistantMessage("still here"),
		]);
		submit(h.terminal, "long task");
		await until(() => h.session().running && h.terminal.output().includes("running"));
		h.terminal.send(KEY.ctrlC);
		await until(() => !h.session().running);
		expect(sawAbort).toBe(true);
		await until(() => expect(h.terminal.output()).toContain("interrupted"));
		submit(h.terminal, "next");
		await until(() => expect(h.terminal.output()).toContain("still here"));
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
	});

	it("aborts the running turn on Esc", async () => {
		const h = await startHarness();
		h.faux.setResponses([
			async (_ctx, opts) =>
				new Promise((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("late", { stopReason: "aborted" })));
				}),
		]);
		submit(h.terminal, "long task");
		await until(() => h.session().running);
		h.terminal.send(KEY.escape);
		await until(() => !h.session().running);
		await until(() => expect(h.terminal.output()).toContain("interrupted"));
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("clears the input on idle Ctrl-C and exits on a second Ctrl-C within a second, restoring the terminal and closing the session", async () => {
		let clock = 1000;
		const h = makeHarness();
		const done = h.start({ now: () => clock });
		await until(() => h.terminal.output().includes("ctx"));
		h.terminal.type("draft text");
		await until(() => expect(h.terminal.output()).toContain("draft text"));
		h.terminal.send(KEY.ctrlC);
		clock += 2000;
		h.terminal.send(KEY.ctrlC); // more than 1 s later: clears again, does not exit
		clock += 500;
		expect(h.terminal.stopped).toBe(false);
		h.terminal.send(KEY.ctrlC);
		expect(await done).toBe(0);
		expect(h.terminal.stopped).toBe(true);
		expect(h.session().status).toBe("closed");
	});

	it("exits on Ctrl-D only when the editor is empty", async () => {
		const h = await startHarness();
		h.terminal.type("x");
		h.terminal.send(KEY.ctrlD);
		await new Promise((r) => setTimeout(r, 30));
		expect(h.terminal.stopped).toBe(false);
		h.terminal.send(KEY.backspace);
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
		expect(h.terminal.stopped).toBe(true);
	});

	it("aborts the turn and exits when the external signal fires (SIGTERM)", async () => {
		const h = makeHarness();
		const ac = new AbortController();
		h.faux.setResponses([
			async (_ctx, opts) =>
				new Promise((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("late", { stopReason: "aborted" })));
				}),
		]);
		const done = h.start({ signal: ac.signal });
		await until(() => h.terminal.output().includes("ctx"));
		submit(h.terminal, "long task");
		await until(() => h.session().running);
		ac.abort();
		expect(await done).toBe(0);
		expect(h.terminal.stopped).toBe(true);
		expect(h.session().status).toBe("closed");
		expect(h.session().turns).toBe(1);
	});

	it("renders a budget refusal inline as error [CODE] message — hint", async () => {
		const h = await startHarness({ overrides: { models: { s1: { provider: "faux", id: "pricey" }, s2: { provider: "faux", id: "slow" } }, providers: { faux: { retryBaseDelayMs: 0 } }, budgets: { perSessionUsd: 0.001, estimateOutputTokens: 1 } } });
		h.faux.setResponses([fauxAssistantMessage("x".repeat(2000))]);
		submit(h.terminal, "spend it");
		await until(() => !h.session().running && h.session().turns === 1);
		submit(h.terminal, "again");
		await until(() => expect(h.terminal.output()).toMatch(/error \[BUDGET_EXCEEDED\] Session budget [^\n]* — Raise it/));
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});
});

describe("chat screen extras", () => {
	it("denies the pending approval and aborts the turn on Ctrl-C", async () => {
		const h = await startHarness();
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "echo never" })]), fauxAssistantMessage("unreachable")]);
		submit(h.terminal, "run it");
		await until(() => expect(h.terminal.output()).toContain("Allow bash: echo never?"));
		h.terminal.send(KEY.ctrlC);
		await until(() => !h.session().running);
		await until(() => expect(h.terminal.output()).toContain("interrupted"));
		expect(h.terminal.output()).not.toContain("unreachable");
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
	});

	it("shows one line per subagent with its status and cost", async () => {
		const h = await startHarness();
		const factory = dispatcher({
			PARENT: [fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "a", instruction: "CHILD-A survey" }, { id: "b", instruction: "CHILD-B survey" }] })]), fauxAssistantMessage("all done")],
			"CHILD-A": [fauxAssistantMessage("a done")],
			"CHILD-B": [fauxAssistantMessage("b done")],
		});
		h.faux.setResponses(Array.from({ length: 10 }, () => factory));
		submit(h.terminal, "PARENT task");
		await until(() => !h.session().running && h.session().turns === 1);
		await until(() => {
			const out = h.terminal.output();
			expect(out).toMatch(/✓ spawn\(2 tasks: a, b\)/);
			expect(out).toMatch(/↳ ✓ subagent CHILD-A survey[^\n]*succeeded · \$\d+\.\d\d/);
			expect(out).toMatch(/↳ ✓ subagent CHILD-B survey[^\n]*succeeded · \$\d+\.\d\d/);
			expect(out).toContain("all done");
		});
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("replays a resumed session's conversation", async () => {
		const first = await startHarness();
		first.faux.setResponses([fauxAssistantMessage([fauxText("Let me look. "), fauxToolCall("read", { path: "x.txt" })]), fauxAssistantMessage("Earlier answer.")]);
		submit(first.terminal, "earlier question");
		await until(() => !first.session().running && first.session().turns === 1);
		first.terminal.send(KEY.ctrlD);
		await first.done;
		const id = first.session().id;

		const h = await startHarness({ reuse: first, resume: id });
		await until(() => {
			const out = h.terminal.output();
			expect(out).toContain("earlier question");
			expect(out).toContain("Let me look.");
			expect(out).toContain("● read(x.txt)");
			expect(out).toContain("Earlier answer.");
			expect(out).toContain("resumed after 1 turn");
		});
		expect(h.session().id).toBe(id);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});
});
