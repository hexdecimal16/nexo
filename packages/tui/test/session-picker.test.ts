import { describe, expect, it } from "vitest";
import { runSessionPicker, type SessionChoice, sessionPickerItems } from "../src/session-picker.ts";
import { FakeTerminal, KEY, until } from "./fake-terminal.ts";

const NOW = Date.parse("2026-10-14T10:00:00.000Z");
const ROWS: SessionChoice[] = [
	{ id: "01SESSIONMIGRATIONAAAAAAAA", title: "can you access my modal account and upgrade ltx", turns: 8, costUsd: 0.4213, updatedAt: "2026-10-14T09:20:00.000Z" },
	{ id: "01SESSIONMEMEAAAAAAAAAAAAA", title: "create a funny dank meme", turns: 1, costUsd: 0.02, updatedAt: "2026-10-14T07:08:00.000Z" },
	{ id: "01SESSIONMAILAAAAAAAAAAAAA", title: "check my latest mails", turns: 3, costUsd: 0, updatedAt: "2026-10-11T08:00:00.000Z" },
];

function start(rows = ROWS, signal?: AbortSignal) {
	const terminal = new FakeTerminal(120, 30);
	const picked = runSessionPicker({ sessions: rows, terminal, signal, now: () => NOW });
	return { terminal, picked };
}

describe("sessionPickerItems", () => {
	it("labels sessions by title with turns, cost, age and id, escaping control characters", () => {
		const items = sessionPickerItems([...ROWS, { id: "01X", title: "evil\x1b[2Jtitle\nnext", turns: 2, costUsd: 1, updatedAt: "2026-10-14T09:59:30.000Z" }, { id: "01Y", title: "", turns: 1, costUsd: 0, updatedAt: "2026-10-01T00:00:00.000Z" }], NOW);
		expect(items[0]).toEqual({ value: "01SESSIONMIGRATIONAAAAAAAA", label: "can you access my modal account and upgrade ltx", description: "8 turns · $0.42 · 40m ago · 01SESSIONMIGRATIONAAAAAAAA" });
		expect(items[1]?.description).toBe("1 turn · $0.02 · 2h ago · 01SESSIONMEMEAAAAAAAAAAAAA");
		expect(items[2]?.description).toContain("3d ago");
		expect(items[3]?.label).not.toMatch(/[\x00-\x1f]/);
		expect(items[3]?.description).toContain("just now");
		expect(items[4]?.label).toBe("(untitled)");
	});
});

describe("runSessionPicker", () => {
	it("lists the sessions and resumes the one picked with the arrow keys", async () => {
		const { terminal, picked } = start();
		await until(() => expect(terminal.output()).toContain("Resume a session"));
		expect(terminal.output()).toContain("create a funny dank meme");
		expect(terminal.output()).toContain("type to filter");
		terminal.send("\x1b[B");
		terminal.send(KEY.enter);
		expect(await picked).toBe("01SESSIONMEMEAAAAAAAAAAAAA");
		expect(terminal.stopped).toBe(true);
	});

	it("filters by typed text, matching titles and ids", async () => {
		const { terminal, picked } = start();
		await until(() => expect(terminal.output()).toContain("Resume a session"));
		terminal.type("mails");
		await until(() => expect(terminal.output()).toContain("filter: mails"));
		terminal.send(KEY.enter);
		expect(await picked).toBe("01SESSIONMAILAAAAAAAAAAAAA");

		const second = start();
		await until(() => expect(second.terminal.output()).toContain("Resume a session"));
		second.terminal.type("MEMEAAA");
		second.terminal.send(KEY.enter);
		expect(await second.picked).toBe("01SESSIONMEMEAAAAAAAAAAAAA");
	});

	it("shows no matches and ignores enter when nothing matches", async () => {
		const { terminal, picked } = start();
		await until(() => expect(terminal.output()).toContain("Resume a session"));
		terminal.type("zzzzqqq");
		await until(() => expect(terminal.output()).toContain("no matches"));
		terminal.send(KEY.enter);
		terminal.send(KEY.escape); // clears the filter
		terminal.send(KEY.escape); // cancels
		expect(await picked).toBeNull();
	});

	it("cancels on ctrl-c and on abort", async () => {
		const { terminal, picked } = start();
		await until(() => expect(terminal.output()).toContain("Resume a session"));
		terminal.send(KEY.ctrlC);
		expect(await picked).toBeNull();

		const ac = new AbortController();
		const aborted = start(ROWS, ac.signal);
		await until(() => expect(aborted.terminal.output()).toContain("Resume a session"));
		ac.abort();
		expect(await aborted.picked).toBeNull();
		expect(aborted.terminal.stopped).toBe(true);
	});
});
