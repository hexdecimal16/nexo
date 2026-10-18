import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { KEY, until } from "./fake-terminal.ts";
import { startHarness, submit } from "./helpers.ts";

function gate(): { wait: Promise<void>; release: () => void } {
	let release: () => void = () => {};
	const wait = new Promise<void>((r) => {
		release = r;
	});
	return { wait, release };
}

describe("queued messages", () => {
	it("queues messages typed during a turn, lists them above the editor and sends them in order", async () => {
		const h = await startHarness();
		const g = gate();
		h.faux.setResponses([
			async () => {
				await g.wait;
				return fauxAssistantMessage("reply one");
			},
			fauxAssistantMessage("reply two"),
			fauxAssistantMessage("reply three"),
		]);
		submit(h.terminal, "first");
		await until(() => h.session().running);
		submit(h.terminal, "second");
		await until(() => expect(h.terminal.output()).toContain("queued (1) · sent when the turn ends"));
		submit(h.terminal, "third");
		await until(() => expect(h.terminal.output()).toContain("queued (2) · sent when the turn ends"));
		await until(() => expect(h.terminal.output()).toContain("⏵ 1 second"));
		expect(h.terminal.output()).toContain("⏵ 2 third");
		// Queued messages enter the chat only when they are sent.
		expect(h.terminal.output()).not.toContain("› second");
		g.release();
		await until(() => expect(h.terminal.output()).toContain("reply three"));
		const out = h.terminal.output();
		expect(out.indexOf("› second")).toBeGreaterThan(-1);
		expect(out.indexOf("› second")).toBeLessThan(out.indexOf("› third"));
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
	});

	it("collapses a long queue into +N more", async () => {
		const h = await startHarness();
		const g = gate();
		h.faux.setResponses([
			async () => {
				await g.wait;
				return fauxAssistantMessage("done");
			},
		]);
		submit(h.terminal, "go");
		await until(() => h.session().running);
		for (const text of ["q1", "q2", "q3", "q4", "q5"]) submit(h.terminal, text);
		await until(() => expect(h.terminal.output()).toContain("… +2 more"));
		// Esc hands the queue back, so nothing else runs.
		h.terminal.send(KEY.escape);
		g.release();
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlC);
		h.terminal.send(KEY.ctrlC);
		expect(await h.done).toBe(0);
	});

	it("moves the queue back to the editor on Esc instead of starting another turn", async () => {
		const h = await startHarness();
		const g = gate();
		h.faux.setResponses([
			async () => {
				await g.wait;
				return fauxAssistantMessage("never shown");
			},
			fauxAssistantMessage("should not run"),
		]);
		submit(h.terminal, "first");
		await until(() => h.session().running);
		submit(h.terminal, "later");
		await until(() => expect(h.terminal.output()).toContain("⏵ 1 later"));
		h.terminal.send(KEY.escape);
		g.release();
		await until(() => !h.session().running);
		await until(() => expect(h.terminal.output()).toContain("interrupted"));
		expect(h.terminal.output()).not.toContain("› later");
		expect(h.terminal.output()).not.toContain("should not run");
		// The text is in the editor, so Enter sends it as a normal turn.
		await until(() => h.faux.state.callCount === 1);
		h.terminal.send("\r");
		await until(() => expect(h.terminal.output()).toContain("› later"));
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
	});
});
