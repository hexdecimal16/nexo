import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { KEY, until, type FakeTerminal } from "./fake-terminal.ts";
import { startHarness } from "./helpers.ts";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Text written after the first `from` writes, with escape sequences removed. */
function since(terminal: FakeTerminal, from: number): string {
	return stripTerminalSequences(terminal.writes.slice(from).join(""));
}

describe("double escape on an idle prompt", () => {
	it("clears the draft on the second Esc and brings it back with Up", async () => {
		const h = await startHarness();
		h.terminal.type("half-written-idea");
		await until(() => expect(h.terminal.output()).toContain("half-written-idea"));
		h.terminal.send(KEY.escape);
		await pause(60);
		// One Esc leaves the draft alone: a repaint here would still show it, and nothing was cleared yet.
		const mark = h.terminal.writes.length;
		h.terminal.send(KEY.escape);
		await until(() => h.terminal.writes.length > mark);
		await pause(60);
		// The repaint after the second Esc no longer contains the draft.
		expect(since(h.terminal, mark)).not.toContain("half-written-idea");
		const afterClear = h.terminal.writes.length;
		h.terminal.send(KEY.up);
		await until(() => expect(since(h.terminal, afterClear)).toContain("half-written-idea"));
		h.terminal.send(KEY.ctrlC);
		h.terminal.send(KEY.ctrlC);
		expect(await h.done).toBe(0);
	});

	it("does nothing on double Esc with an empty prompt", async () => {
		const h = await startHarness();
		h.terminal.send(KEY.escape);
		await pause(60);
		h.terminal.send(KEY.escape);
		await pause(60);
		h.terminal.type("still-works");
		await until(() => expect(h.terminal.output()).toContain("still-works"));
		h.terminal.send(KEY.ctrlC);
		h.terminal.send(KEY.ctrlC);
		expect(await h.done).toBe(0);
	});
});
