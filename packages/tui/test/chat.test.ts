import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { dispatcher } from "../../core/test/helpers.ts";
import { restoreTerminal } from "../src/index.ts";
import { KEY, until } from "./fake-terminal.ts";
import { makeHarness, startHarness, submit } from "./helpers.ts";

describe("chat screen", () => {
	it("shows a neutral opening footer until the session exists", async () => {
		const h = makeHarness();
		let seen = "";
		const done = h.start({
			openSession: (prompter) => {
				seen = h.terminal.output();
				return h.openSession(prompter);
			},
		});
		await until(() => h.terminal.started && h.terminal.output().includes("nexo session"));
		expect(seen).toContain("nexo · opening…");
		expect(seen).not.toContain("nexo · setup");
		h.terminal.send(KEY.ctrlD);
		await done;
	});

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
		const h = await startHarness({ workspace: "." });
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

	it("expands every tool line to its full arguments and output on ctrl+o", async () => {
		const h = await startHarness({ workspace: "." });
		const { writeFileSync } = await import("node:fs");
		const name = `${"long-name-".repeat(10)}END.txt`;
		writeFileSync(`${h.cwd}/${name}`, Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join("\n"));
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: name })]), fauxAssistantMessage("read it")]);
		submit(h.terminal, "read long");
		await until(() => !h.session().running && h.session().turns === 1);
		await until(() => expect(h.terminal.output()).toContain("more lines (ctrl+o to expand)"));
		expect(h.terminal.output()).not.toContain("row 10");
		expect(h.terminal.output()).not.toContain("END.txt");
		h.terminal.send(KEY.ctrlO);
		await until(() => {
			expect(h.terminal.output()).toContain("row 10");
			expect(h.terminal.output()).toContain("END.txt");
		});
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("toggles on a kitty ctrl+o press and ignores its release", async () => {
		const h = await startHarness({ workspace: "." });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(`${h.cwd}/rows.txt`, Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join("\n"));
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "rows.txt" })]), fauxAssistantMessage("read it")]);
		submit(h.terminal, "read rows");
		await until(() => !h.session().running && h.session().turns === 1);
		h.terminal.send(KEY.ctrlOPress);
		h.terminal.send(KEY.ctrlORelease);
		await new Promise((r) => setTimeout(r, 100));
		expect(h.terminal.screen()).toContain("row 10");
		h.terminal.send(KEY.ctrlOPress);
		h.terminal.send(KEY.ctrlORelease);
		await new Promise((r) => setTimeout(r, 100));
		expect(h.terminal.screen()).not.toContain("row 10");
		expect(h.terminal.screen()).toContain("more lines (ctrl+o to expand)");
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("does not count a kitty ctrl+c release as a second ctrl+c", async () => {
		const h = await startHarness();
		h.terminal.send(KEY.ctrlC);
		h.terminal.send(KEY.ctrlCRelease);
		await new Promise((r) => setTimeout(r, 100));
		expect(h.terminal.stopped).toBe(false);
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

	it("denies on esc without stopping the turn, then gives the editor back", async () => {
		const h = await startHarness();
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "echo esc-run" })]), fauxAssistantMessage("carried on")]);
		submit(h.terminal, "run it");
		await until(() => expect(h.terminal.output()).toContain("Allow bash: echo esc-run?"));
		await new Promise((r) => setTimeout(r, 450));
		h.terminal.send(KEY.escape);
		await until(() => expect(h.terminal.output()).toMatch(/✗ bash\(echo esc-run\)/));
		await until(() => expect(h.terminal.output()).toContain("carried on"));
		await until(() => !h.session().running);
		h.terminal.type("next-draft");
		await until(() => expect(h.terminal.output()).toContain("next-draft"));
		h.terminal.send(KEY.ctrlC);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("asks for approval in place of the editor and returns Allow or Deny to the policy", async () => {
		const h = await startHarness();
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo approved-run" })]),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo denied-run" })]),
			fauxAssistantMessage("finished"),
		]);
		submit(h.terminal, "run things");
		await until(() => expect(h.terminal.output()).toContain("Allow bash: echo approved-run?"));
		expect(h.terminal.output()).toContain("Allow once");
		expect(h.terminal.output()).toContain("Always allow");
		// The tool line spins while the approval is pending.
		expect(h.terminal.output()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] bash\(echo approved-run\)/);
		expect(h.terminal.output()).toContain("Deny");
		// An Enter typed ahead as the approval box appears is ignored (and Deny is preselected anyway).
		h.terminal.send(KEY.enter);
		await new Promise((r) => setTimeout(r, 100));
		expect(h.terminal.output()).not.toMatch(/✓ bash\(echo approved-run\)/);
		expect(h.terminal.output()).not.toMatch(/✗ bash\(echo approved-run\)/);
		await new Promise((r) => setTimeout(r, 400));
		h.terminal.send(KEY.up); // Always allow
		h.terminal.send(KEY.up); // Allow once
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toMatch(/✓ bash\(echo approved-run\)/));
		await until(() => expect(h.terminal.output()).toContain("Allow bash: echo denied-run?"));
		await new Promise((r) => setTimeout(r, 450));
		h.terminal.send(KEY.enter); // Deny is the default
		await until(() => expect(h.terminal.output()).toMatch(/✗ bash\(echo denied-run\)/));
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("shows model, effort, turn and session cost, cap and context in the footer", async () => {
		const h = await startHarness({ overrides: { models: { s1: { provider: "faux", id: "slow" }, s2: { provider: "faux", id: "slow" } }, providers: { faux: { retryBaseDelayMs: 0, rateLimitBaseDelayMs: 0 } }, budgets: { perSessionUsd: 5 } } });
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
		const h = await startHarness({ overrides: { models: { s1: { provider: "faux", id: "pricey" }, s2: { provider: "faux", id: "slow" } }, providers: { faux: { retryBaseDelayMs: 0, rateLimitBaseDelayMs: 0 } }, budgets: { perSessionUsd: 0.001, estimateOutputTokens: 1 } } });
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

describe("stored keys on screen", () => {
	const STORED = "sk-live-0123456789abcdefghijklmnopqrstuvwxyz";

	it("never draws a stored key the model streams, even split across deltas", async () => {
		const h = await startHarness();
		h.settings.setKey("faux", STORED);
		h.faux.setResponses([fauxAssistantMessage(`the credentials file says ${STORED} and that is all`)]);
		submit(h.terminal, "show it");
		await until(() => expect(h.terminal.output()).toContain("and that is all"));
		await until(() => !h.session().running);
		expect(h.terminal.output()).toContain("[REDACTED]");
		expect(h.terminal.raw()).not.toContain(STORED);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("shows [REDACTED] for a stored key in an approval question", async () => {
		const h = await startHarness();
		h.settings.setKey("faux", STORED);
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `curl -H "Authorization: ${STORED}" example.com` })]), fauxAssistantMessage("done")]);
		submit(h.terminal, "call it");
		await until(() => expect(h.terminal.output()).toContain("Approval needed"));
		expect(h.terminal.output()).toContain("Authorization: [REDACTED]");
		expect(h.terminal.raw()).not.toContain(STORED);
		h.terminal.send(KEY.ctrlC);
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});
});

describe("hostile text", () => {
	it("escapes control characters in assistant text, result previews and error messages", async () => {
		const h = await startHarness({ workspace: "." });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(`${h.cwd}/ansi.txt`, "before\x1b]0;pwned\x07after\n");
		h.faux.setResponses([
			fauxAssistantMessage([fauxText("clear\x1b[2Jscreen ‮evil "), fauxToolCall("read", { path: "ansi.txt" })]),
			fauxAssistantMessage("ok", { stopReason: "error", errorMessage: "boom\x1b[31mred" }),
		]);
		submit(h.terminal, "be hostile");
		await until(() => !h.session().running && h.session().turns === 1);
		await until(() => {
			const out = h.terminal.output();
			expect(out).toContain("clear\\x1b[2Jscreen");
			expect(out).toContain("\\u202eevil");
			expect(out).toContain("before\\x1b]0;pwned\\x07after");
			expect(out).toContain("boom\\x1b[31mred");
		});
		const raw = h.terminal.raw();
		expect(raw).not.toContain("\x1b[2J");
		expect(raw).not.toContain("\x1b]0;pwned");
		expect(raw).not.toContain("‮");
		expect(raw).not.toContain("boom\x1b[31m");
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("escapes bidi and zero-width characters in tool summaries and approval questions", async () => {
		const h = await startHarness();
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "echo safe‮​hidden" })]), fauxAssistantMessage("ok")]);
		submit(h.terminal, "run it");
		await until(() => expect(h.terminal.output()).toContain("Allow bash: echo safe\\u202e\\u200bhidden?"));
		expect(h.terminal.output()).toContain("bash(echo safe\\u202e\\u200bhidden)");
		expect(h.terminal.raw()).not.toMatch(/[‮​]/);
		h.terminal.send(KEY.ctrlC);
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("shows markdown link targets as text, never as hidden OSC 8 hyperlinks", async () => {
		const h = await startHarness();
		h.faux.setResponses([fauxAssistantMessage("see [the docs](https://evil.example/x) now")]);
		submit(h.terminal, "link please");
		await until(() => expect(h.terminal.output()).toContain("the docs (https://evil.example/x)"));
		// pi-tui closes hyperlinks at every line end (an empty OSC 8); none may carry a target.
		expect(h.terminal.raw()).not.toMatch(/\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]/);
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});
});

describe("exit robustness", () => {
	/** Makes the session's turns never settle, even when aborted. */
	const stickTurns = (h: { session: () => { turn: unknown } }) => {
		h.session().turn = () => new Promise<never>(() => {});
	};

	it("stops waiting for a turn that ignores the abort on a second Ctrl-C, and still restores the terminal", async () => {
		const h = await startHarness({ interactive: { exitTimeoutMs: 60_000 } });
		stickTurns(h);
		submit(h.terminal, "hang");
		await until(() => expect(h.terminal.output()).toContain("running…"));
		submit(h.terminal, "/exit");
		await until(() => expect(h.terminal.output()).toContain("stopping the turn"));
		expect(h.terminal.stopped).toBe(false);
		h.terminal.send(KEY.ctrlC);
		expect(await h.done).toBe(0);
		expect(h.terminal.stopped).toBe(true);
	});

	it("gives up on a stuck turn after the exit deadline", async () => {
		const h = await startHarness({ interactive: { exitTimeoutMs: 100 } });
		stickTurns(h);
		submit(h.terminal, "hang");
		await until(() => expect(h.terminal.output()).toContain("running…"));
		submit(h.terminal, "/exit");
		expect(await h.done).toBe(0);
		expect(h.terminal.stopped).toBe(true);
	});

	it("restoreTerminal stops every running TUI (for the CLI's crash handlers)", async () => {
		const h = await startHarness();
		restoreTerminal();
		expect(h.terminal.stopped).toBe(true);
		restoreTerminal();
	});
});

describe("! shell commands", () => {
	it("runs a ! command without a model call, shows its output and exit code, and sends it with the next message", async () => {
		const h = await startHarness();
		let sent = "";
		h.faux.setResponses([
			async (ctx) => {
				const last = ctx.messages.at(-1);
				sent = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b) => ("text" in b ? b.text : "")).join("");
				return fauxAssistantMessage("seen it");
			},
		]);
		submit(h.terminal, "!echo hi-from-shell; exit 2");
		await until(() => expect(h.terminal.output()).toContain("exit code 2"));
		expect(h.terminal.output()).toContain("! echo hi-from-shell; exit 2");
		expect(h.terminal.output()).toContain("hi-from-shell");
		expect(h.session().pendingShellCount).toBe(1);
		expect(h.session().turns).toBe(0);
		submit(h.terminal, "what happened?");
		await until(() => expect(h.terminal.output()).toContain("seen it"));
		expect(sent).toContain("$ echo hi-from-shell; exit 2\n[exit code 2]\nhi-from-shell");
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
	});

	it("stops a running ! command on Esc and refuses a bare !", async () => {
		const h = await startHarness();
		submit(h.terminal, "!");
		await until(() => expect(h.terminal.output()).toContain("Type a command after !"));
		submit(h.terminal, "!sleep 5");
		await until(() => h.session().running && h.terminal.output().includes("running"));
		submit(h.terminal, "!echo overlap");
		await until(() => expect(h.terminal.output()).toContain("A command is running"));
		h.terminal.send(KEY.escape);
		await until(() => !h.session().running);
		await until(() => expect(h.terminal.output()).toContain("stopped"));
		expect(h.terminal.output()).not.toContain("overlap\n");
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
	});

	it("colors the editor border and swaps the footer for a shell-mode note while the input starts with !", async () => {
		const h = await startHarness();
		const MAGENTA_BORDER = "\x1b[35m─";
		const DIM_BORDER = "\x1b[2m─";
		const since = (mark: number) => h.terminal.raw().slice(mark);
		let mark = h.terminal.raw().length;
		h.terminal.type("!");
		await until(() => expect(since(mark)).toContain(MAGENTA_BORDER));
		await until(() => expect(h.terminal.output()).toContain("! shell mode"));
		expect(h.terminal.output()).toContain("output goes to the model with your next message");
		mark = h.terminal.raw().length;
		h.terminal.send(KEY.backspace);
		await until(() => expect(since(mark)).toContain(DIM_BORDER));
		expect(since(mark)).not.toContain(MAGENTA_BORDER);
		await until(() => expect(since(mark)).toContain("ctx "));
		submit(h.terminal, "!echo back");
		await until(() => expect(h.terminal.output()).toContain("exit code 0"));
		const raw = h.terminal.raw();
		expect(raw.lastIndexOf(DIM_BORDER)).toBeGreaterThan(raw.lastIndexOf(MAGENTA_BORDER));
		expect(raw.lastIndexOf("ctx ")).toBeGreaterThan(raw.lastIndexOf("! shell mode"));
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
	});

	it("shows only the last lines of a long output", async () => {
		const h = await startHarness();
		submit(h.terminal, "!seq 1 500");
		await until(() => expect(h.terminal.output()).toContain("exit code 0"));
		expect(h.terminal.output()).toContain("300 earlier lines not shown");
		expect(h.terminal.output()).toContain("500");
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
	});
});

describe("where files go", () => {
	it("names each turn's run folder as where files go, on start and in /help", async () => {
		const h = await startHarness({ columns: 300 });
		const line = `files: ${h.paths.runs}/<turn id>/workspace (carried over each turn)`;
		await until(() => expect(h.terminal.output()).toContain(line));
		submit(h.terminal, "/help");
		await until(() => expect(h.terminal.output().split(line)).toHaveLength(3));
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("names the --workspace folder as where files go, escaping control characters", async () => {
		const { mkdirSync, realpathSync } = await import("node:fs");
		const cwdHarness = makeHarness({ columns: 300 });
		mkdirSync(`${cwdHarness.cwd}/dir\x1b[31mred`);
		const e = makeHarness({ reuse: { paths: cwdHarness.paths, cwd: cwdHarness.cwd }, workspace: "dir\x1b[31mred", columns: 300 });
		const done = e.start();
		const dir = realpathSync(`${cwdHarness.cwd}/dir\x1b[31mred`);
		await until(() => expect(e.terminal.output()).toContain(`files: ${dir.replace("\x1b", "\\x1b")}`));
		expect(e.terminal.output()).not.toContain("carried over");
		expect(e.terminal.raw()).not.toContain("dir\x1b[31mred");
		submit(e.terminal, "/help");
		await until(() => expect(e.terminal.output().split(`files: ${dir.replace("\x1b", "\\x1b")}`)).toHaveLength(3));
		e.terminal.send(KEY.ctrlD);
		await done;
	});

	it("names the resumed session's folder: a run-folder session keeps carrying files over", async () => {
		const first = await startHarness({ columns: 300 });
		first.faux.setResponses([fauxAssistantMessage("one")]);
		submit(first.terminal, "hello");
		await until(() => !first.session().running && first.session().turns === 1);
		const id = first.session().id;
		first.terminal.send(KEY.ctrlD);
		await first.done;
		const again = makeHarness({ reuse: { paths: first.paths, cwd: first.cwd }, resume: id, columns: 300 });
		const done = again.start();
		await until(() => expect(again.terminal.output()).toContain(`files: ${first.paths.runs}/<turn id>/workspace (carried over each turn)`));
		again.terminal.send(KEY.ctrlD);
		await done;
	});
});
