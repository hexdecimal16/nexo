import { chmodSync, writeFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Block, DynamicLine, MaskedInput, SafeMarkdown, SubagentLine, SubagentPanel, Ticker, ToolLine, ViewMode } from "../src/components.ts";
import { SettingsScreen } from "../src/settings-screen.ts";
import { markdownTheme } from "../src/theme.ts";
import { KEY, until } from "./fake-terminal.ts";
import { FAUX_ROLES, makeHarness, startHarness, submit } from "./helpers.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const LONG = `x${"y".repeat(150)}`;

function fits(lines: string[], width: number): void {
	for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(width);
}

describe("narrow terminals", () => {
	it("keeps every component within the width with long unbroken strings", () => {
		const ticker = new Ticker();
		const view = new ViewMode();
		const tool = new ToolLine(`bash(${LONG})`, `bash(${LONG})`, ticker, view);
		fits(tool.render(40), 40);
		tool.finish(false, 12, `${LONG}\n${LONG}`);
		fits(tool.render(40), 40);
		view.verbose = true;
		fits(tool.render(40), 40);
		const sub = new SubagentLine(LONG, 3, ticker, `${LONG} · faux/fast`);
		sub.approved(LONG);
		fits(sub.render(40), 40);
		fits(new Block(`${LONG}\n${LONG}`, (s) => s, "› ").render(40), 40);
		fits(new DynamicLine(() => `faux/${LONG} · high · turn $0.00`).render(40), 40);
		fits(new SafeMarkdown(`# ${LONG}\n\n\`\`\`\n${LONG}\n\`\`\`\n\n| a | ${LONG} |\n|---|---|\n| 1 | 2 |`, 0, 1, markdownTheme).render(40), 40);
		const masked = new MaskedInput("key> ");
		for (let i = 0; i < 100; i++) masked.handleInput("a");
		fits(masked.render(40), 40);
		fits(masked.render(3), 3);
	});

	it("wraps a verbose tool line to the full output and collapses it again", () => {
		const view = new ViewMode();
		const output = Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join("\n");
		const tool = new ToolLine("read(short)", `read(${LONG})`, new Ticker(), view);
		tool.finish(false, 5, output);
		const collapsed = tool.render(40).join("\n");
		expect(collapsed).toContain("row 3");
		expect(collapsed).not.toContain("row 4");
		expect(collapsed).toContain("7 more lines (ctrl+o to expand)");
		view.verbose = true;
		const lines = tool.render(40);
		fits(lines, 40);
		const expanded = lines.join("\n");
		expect(expanded).toContain("row 10");
		expect(expanded.replace(/\x1b\[[0-9;]*m|\s+/g, "")).toContain(LONG);
		view.verbose = false;
		expect(tool.render(40).join("\n")).not.toContain("row 10");
	});

	it("renders the settings screen with a long filter and long values at 40 columns", () => {
		const h = makeHarness({ userConfig: { ...FAUX_ROLES } });
		const screen = new SettingsScreen({ settings: h.settings, mode: "settings", rows: () => 20, requestRender: () => {}, onClose: () => {} });
		fits(screen.render(40), 40);
		screen.handleInput(KEY.enter); // first item: the faux key actions
		fits(screen.render(40), 40);
		screen.handleInput(KEY.escape);
		for (const ch of "Model s1") screen.handleInput(ch);
		screen.handleInput(KEY.enter);
		for (const ch of `provider/${LONG}`) screen.handleInput(ch);
		const lines = screen.render(40);
		fits(lines, 40);
		expect(lines.join("\n")).toContain("enter uses");
	});

	it("survives a 122-character model id typed into the settings filter of a 40-column TUI", async () => {
		const h = await startHarness({ userConfig: { ...FAUX_ROLES }, columns: 40 });
		submit(h.terminal, "/settings");
		await until(() => expect(h.terminal.output()).toContain("Settings"));
		h.terminal.type("Model s1");
		h.terminal.send(KEY.enter);
		h.terminal.type(`openai/${"m".repeat(115)}`);
		await until(() => expect(h.terminal.output()).toContain("enter uses"));
		h.terminal.send(KEY.escape);
		h.terminal.send(KEY.escape);
		h.terminal.send(KEY.escape);
		await until(() => expect(h.terminal.output()).toContain("settings closed"));
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
	});

	it("draws the approval box at 40 columns with a long unbroken command", async () => {
		const h = await startHarness({ columns: 40 });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `echo ${LONG}` })]), fauxAssistantMessage("ok")]);
		submit(h.terminal, "go");
		await until(() => expect(h.terminal.output()).toContain("Approval needed"));
		h.terminal.send(KEY.ctrlC);
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		expect(await h.done).toBe(0);
	});
});

describe("config-controlled strings", () => {
	it("escapes provider names from credentials.json in the settings list", async () => {
		const h = makeHarness({ userConfig: { ...FAUX_ROLES } });
		writeFileSync(h.paths.credentials, JSON.stringify({ "ev‮il\x1b[31m": { apiKey: "abcdefghijklmnop" } }));
		chmodSync(h.paths.credentials, 0o600);
		const screen = new SettingsScreen({
			settings: (await import("@nexo/core")).createSettings({ paths: h.paths, cwd: h.cwd, env: {}, models: h.models }),
			mode: "settings",
			rows: () => 30,
			requestRender: () => {},
			onClose: () => {},
		});
		const out = screen.render(100).join("\n");
		expect(out).toContain("ev\\u202eil\\x1b[31m key");
		expect(out).not.toContain("‮");
	});
});

describe("masked input", () => {
	it("lets Esc break out of an unterminated bracketed paste and forgets the pasted text", () => {
		const masked = new MaskedInput("key> ");
		const submitted: string[] = [];
		let cancelled = 0;
		masked.onSubmit = (v) => submitted.push(v);
		masked.onCancel = () => cancelled++;
		masked.handleInput("\x1b[200~half-pasted-secret");
		masked.handleInput(KEY.enter); // still inside the paste
		masked.handleInput(KEY.escape);
		expect(cancelled).toBe(1);
		expect(masked.length).toBe(0);
		masked.handleInput("\x1b[200~more");
		masked.handleInput(KEY.ctrlC);
		expect(cancelled).toBe(2);
		for (const ch of "newkey12") masked.handleInput(ch);
		masked.handleInput(KEY.enter);
		expect(submitted).toEqual(["newkey12"]);
		expect(masked.length).toBe(0);
	});
});

describe("SubagentLine approvals", () => {
	it("shows only the latest auto-allowed reason while running and drops it when done", () => {
		const line = new SubagentLine("research", 1, new Ticker(), "c · faux/fast");
		line.approved("first reason");
		line.approved("second reason");
		const running = line.render(120).join("\n");
		expect(running).toContain("auto-allowed: second reason");
		expect(running).not.toContain("first reason");
		line.finish("succeeded", 0);
		expect(line.render(120).join("\n")).not.toContain("auto-allowed");
	});
});

describe("SubagentPanel", () => {
	const ticker = new Ticker();
	const make = (n: number) => Array.from({ length: n }, (_, i) => new SubagentLine(`task ${i}`, 1, ticker, `t${i} · faux/fast`));

	it("never renders more rows than its budget, collapsing finished rows and counting the overflow", () => {
		const panel = new SubagentPanel(() => 6);
		const lines = make(10);
		for (const line of lines) {
			line.toolStarted("web_fetch(https://example.com)");
			panel.add(line);
		}
		lines[0]?.finish("succeeded", 0.01);
		lines[1]?.finish("succeeded", 0.01);
		const out = panel.render(80).join("\n");
		expect(panel.render(80).length).toBeLessThanOrEqual(6);
		expect(out).toContain("2 subagents finished");
		expect(out).toContain("… +5 more running");
		expect(out).not.toContain("web_fetch");
	});

	it("shows every row in full when they fit, and hands rows over in start order", () => {
		const panel = new SubagentPanel(() => 40);
		const lines = make(3);
		for (const line of lines) panel.add(line);
		lines[1]?.toolStarted("bash(ls)");
		expect(panel.render(80).join("\n")).toContain("bash(ls)");
		expect(panel.anyRunning).toBe(true);
		for (const line of lines) line.finish("succeeded", 0);
		expect(panel.anyRunning).toBe(false);
		expect(panel.takeFinished()).toEqual(lines);
		expect(panel.render(80)).toEqual([]);
	});
});
