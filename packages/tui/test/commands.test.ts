import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { latestFeedback } from "@nexo/store";
import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "../src/index.ts";
import { KEY, until } from "./fake-terminal.ts";
import { startHarness, submit } from "./helpers.ts";

describe("parseSlashCommand", () => {
	it("splits the command name from its argument text", () => {
		expect(parseSlashCommand("/notdone  missed the edge case ")).toEqual({ name: "notdone", args: "missed the edge case" });
		expect(parseSlashCommand("/help")).toEqual({ name: "help", args: "" });
		expect(parseSlashCommand("hello /help")).toBeNull();
		expect(parseSlashCommand("/")).toEqual({ name: "", args: "" });
	});
});

describe("slash commands", () => {
	it("Enter on an argument completion accepts it and submits the command", async () => {
		const h = await startHarness();
		h.terminal.type("/effort hi");
		await until(() => expect(h.terminal.output()).toContain("high"));
		h.terminal.send(KEY.enter);
		await until(() => expect(h.session().effort).toBe("high"));
		await until(() => expect(h.terminal.output()).toMatch(/s1|fast/));
		h.terminal.type("/cost");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("last turn"));
		expect(h.terminal.output()).not.toContain("/effort high/cost");
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("/help lists the commands", async () => {
		const h = await startHarness();
		submit(h.terminal, "/help");
		await until(() => {
			const out = h.terminal.output();
			for (const name of ["/done", "/notdone", "/cost", "/budget", "/model", "/effort", "/compact", "/clear", "/sessions", "/settings", "/exit"]) {
				expect(out).toContain(name);
			}
		});
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("/budget, /model and /effort set the session overrides; bad values are reported inline", async () => {
		const h = await startHarness();
		submit(h.terminal, "/budget 7.5");
		await until(() => expect(h.session().budgetUsd).toBe(7.5));
		await until(() => expect(h.terminal.output()).toContain("$0.00/$7.50"));
		submit(h.terminal, "/model s2");
		await until(() => expect(h.session().model).toBe("s2"));
		submit(h.terminal, "/effort high");
		await until(() => expect(h.session().effort).toBe("high"));
		await until(() => expect(h.terminal.output()).toMatch(/s2 · high/));

		submit(h.terminal, "/budget lots");
		await until(() => expect(h.terminal.output()).toMatch(/error \[INVALID_REQUEST\] Budget must be a positive number/));
		submit(h.terminal, "/model nope/missing");
		await until(() => expect(h.terminal.output()).toMatch(/error \[INVALID_REQUEST\][^\n]*— Use "s1", "s2"/));
		submit(h.terminal, "/effort wild");
		await until(() => expect(h.terminal.output()).toMatch(/error \[INVALID_REQUEST\] Effort must be one of/));
		expect(h.session().budgetUsd).toBe(7.5);
		expect(h.session().model).toBe("s2");
		expect(h.session().effort).toBe("high");

		submit(h.terminal, "/model default");
		await until(() => expect(h.session().model).toBeNull());
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("/done and /notdone review the last turn; before any turn they report the error", async () => {
		const h = await startHarness();
		submit(h.terminal, "/done");
		await until(() => expect(h.terminal.output()).toContain("error [INVALID_REQUEST] There is no turn to review yet"));
		h.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		submit(h.terminal, "first");
		await until(() => !h.session().running && h.session().turns === 1);
		submit(h.terminal, "/done");
		await until(() => expect(latestFeedback(h.db, h.session().lastRunId as string)?.verdict).toBe("done"));
		submit(h.terminal, "second");
		await until(() => !h.session().running && h.session().turns === 2);
		submit(h.terminal, "/notdone missed the edge case");
		await until(() => expect(latestFeedback(h.db, h.session().lastRunId as string)).toMatchObject({ verdict: "not_done", comment: "missed the edge case" }));
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("/compact, /clear, /cost and /sessions call the session and render their result", async () => {
		const h = await startHarness();
		h.faux.setResponses([fauxAssistantMessage("hi")]);
		submit(h.terminal, "hello");
		await until(() => !h.session().running && h.session().turns === 1);
		submit(h.terminal, "/compact");
		await until(() => expect(h.session().compactPending).toBe(true));
		submit(h.terminal, "/clear");
		await until(() => expect(h.session().transcript().at(-1)).toMatchObject({ type: "compaction", summary: "" }));
		submit(h.terminal, "/cost");
		await until(() => expect(h.terminal.output()).toMatch(/session \$\d+\.\d+ of \$5\.00/));
		submit(h.terminal, "/sessions");
		await until(() => expect(h.terminal.output()).toContain(h.session().id));
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("/clear wipes the screen and scrollback, keeping the session header", async () => {
		const h = await startHarness();
		h.faux.setResponses([fauxAssistantMessage("first-reply-text")]);
		submit(h.terminal, "earlier question");
		await until(() => expect(h.terminal.output()).toContain("first-reply-text"));
		await until(() => expect(h.session().running).toBe(false));
		submit(h.terminal, "/clear");
		await until(() => expect(h.terminal.screen()).toContain("conversation cleared"));
		const screen = h.terminal.screen();
		expect(screen).not.toContain("first-reply-text");
		// Only the header's session title still names the first message; its echoed block is gone.
		expect(screen.split("earlier question")).toHaveLength(2);
		expect(screen).toContain(`session ${h.session().id} · earlier question`);
		expect(screen).toContain("files:");
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("reports an unknown command and refuses commands while a turn runs", async () => {
		const h = await startHarness();
		submit(h.terminal, "/bogus");
		await until(() => expect(h.terminal.output()).toContain("Unknown command /bogus"));
		h.faux.setResponses([
			async (_ctx, opts) =>
				new Promise((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("late", { stopReason: "aborted" })));
				}),
		]);
		submit(h.terminal, "long task");
		await until(() => h.session().running);
		submit(h.terminal, "/compact");
		await until(() => expect(h.terminal.output()).toContain("A turn is running"));
		expect(h.session().compactPending).toBe(false);
		h.terminal.send(KEY.ctrlC);
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});

	it("/exit leaves the TUI and closes the session", async () => {
		const h = await startHarness();
		submit(h.terminal, "/exit");
		expect(await h.done).toBe(0);
		expect(h.terminal.stopped).toBe(true);
		expect(h.session().status).toBe("closed");
	});
});
