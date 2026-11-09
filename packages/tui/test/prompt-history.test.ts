import { describe, expect, it } from "vitest";
import { recentPrompts, recordPrompt } from "@nexo/core";
import { KEY, until } from "./fake-terminal.ts";
import { makeHarness, submit } from "./helpers.ts";

describe("prompt history across runs", () => {
	it("recalls with Up a prompt typed in an earlier run", async () => {
		const first = makeHarness();
		const historyFor = (h: typeof first) => ({
			recent: (cwd: string) => recentPrompts(h.paths, { cwd }).map((e) => e.text),
			record: (entry: { text: string; cwd: string; sessionId: string }) => recordPrompt(h.paths, h.settings.redact, entry),
		});
		const done1 = first.start({ promptHistory: historyFor(first) });
		await until(() => first.terminal.started && first.terminal.output().includes("nexo session"));
		submit(first.terminal, "/budget 3");
		await until(() => expect(first.terminal.output()).toContain("session budget set"));
		first.terminal.send(KEY.ctrlD);
		await done1;

		const second = makeHarness({ reuse: first });
		const done2 = second.start({ promptHistory: historyFor(second) });
		await until(() => second.terminal.started && second.terminal.output().includes("nexo session"));
		expect(second.terminal.output()).not.toContain("/budget 3");
		second.terminal.send(KEY.up);
		await until(() => expect(second.terminal.output()).toContain("/budget 3"));
		// Ctrl-D quits only on an empty editor, so clear the recalled text first.
		second.terminal.send(KEY.ctrlC);
		second.terminal.send(KEY.ctrlD);
		await done2;
	});
});
