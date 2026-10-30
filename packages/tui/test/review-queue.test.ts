import { insertRun } from "@nexo/store";
import { describe, expect, it } from "vitest";
import { runRow } from "../../store/test/fixtures.ts";
import { KEY, until } from "./fake-terminal.ts";
import { startHarness } from "./helpers.ts";

describe("/queue", () => {
	it("says when nothing needs review, then lists a new unreviewed run", async () => {
		const h = await startHarness();
		h.terminal.type("/queue");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("no unreviewed runs"));
		insertRun(h.db, runRow({ status: "failed", instruction: "QUEUE-PROBE task", startedAt: new Date().toISOString() }));
		h.terminal.type("/queue");
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("QUEUE-PROBE"));
		expect(h.terminal.output()).toContain("failed");
	});
});
