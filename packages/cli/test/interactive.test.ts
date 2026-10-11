import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, resolveNexoPaths, upsertSessionRow } from "@nexo/store";
import { FakeTerminal, KEY, until } from "../../tui/test/fake-terminal.ts";
import { FAUX_MODELS } from "../../core/test/helpers.ts";
import { installCrashHandlers } from "../src/interactive.ts";
import { type CliIO, type CliOptions, EXIT_SIGINT, runCli } from "../src/main.ts";
import { createRuntime } from "../src/runtime.ts";

function io(): CliIO & { out: () => string; err: () => string } {
	let out = "";
	let err = "";
	return {
		stdout: { write: (s: string) => ((out += s), true) },
		stderr: { write: (s: string) => ((err += s), true) },
		out: () => out,
		err: () => err,
	};
}

const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const roles = {
	models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } },
	providers: { faux: { retryBaseDelayMs: 0 } },
};

function home(config?: unknown): { env: NodeJS.ProcessEnv; cwd: string; home: string } {
	const root = mkdtempSync(join(tmpdir(), "nexo-cli-i-"));
	roots.push(root);
	mkdirSync(join(root, "home"), { recursive: true });
	if (config) writeFileSync(join(root, "home", "config.json"), JSON.stringify(config));
	return { env: { NEXO_HOME: join(root, "home") }, cwd: root, home: join(root, "home") };
}

function fauxModels() {
	const faux = fauxProvider({ models: FAUX_MODELS });
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

const tty = { isTTY: true };
function ttyStdio(stdin: object = {}) {
	return { stdin: Object.assign(new PassThrough(), tty, stdin), stdout: tty, stderr: tty } as unknown as NonNullable<CliOptions["stdio"]>;
}
function pipedStdio(text: string, stdout: object = {}) {
	return { stdin: Readable.from([text]), stdout, stderr: {} } as unknown as NonNullable<CliOptions["stdio"]>;
}

function addSession(h: { env: NodeJS.ProcessEnv }, id: string, over: Record<string, unknown> = {}): void {
	const paths = resolveNexoPaths(h.env);
	mkdirSync(paths.sessions, { recursive: true });
	const db = openDb(paths.db);
	upsertSessionRow(db, {
		id,
		title: "hello",
		cwd: "/w",
		status: "closed",
		budgetUsd: 5,
		costUsd: 0.25,
		turns: 2,
		createdAt: "2026-10-11T00:00:00.000Z",
		updatedAt: "2026-10-11T00:01:00.000Z",
		dirPath: join(paths.sessions, id),
		...over,
	});
}

describe("routing", () => {
	it("exits 2 with a usage hint for no arguments without a terminal", async () => {
		const h = home(roles);
		const t = io();
		const code = await runCli([], t, { ...h, models: fauxModels(), stdio: pipedStdio("", {}) });
		expect(code).toBe(2);
		expect(t.err()).toContain("interactive terminal");
		expect(t.err()).toContain("nexo run");
	});

	it("needs all three streams to be terminals", async () => {
		const h = home(roles);
		for (const stdio of [
			{ stdin: { isTTY: true }, stdout: { isTTY: true }, stderr: {} },
			{ stdin: { isTTY: true }, stdout: {}, stderr: { isTTY: true } },
			{ stdin: {}, stdout: { isTTY: true }, stderr: { isTTY: true } },
		]) {
			const t = io();
			const code = await runCli([], t, { ...h, models: fauxModels(), stdio: stdio as never });
			expect(code).toBe(2);
		}
	});

	it("exits 2 for --resume without a terminal", async () => {
		const h = home(roles);
		expect(await runCli(["--resume", "abc"], io(), { ...h, models: fauxModels(), stdio: pipedStdio("") })).toBe(2);
	});

	it("exits with NOT_FOUND for an unknown --resume id, before the terminal starts", async () => {
		const h = home(roles);
		const terminal = new FakeTerminal();
		const t = io();
		const code = await runCli(["--resume", "nope"], t, { ...h, models: fauxModels(), stdio: ttyStdio(), terminal });
		expect(code).toBe(1);
		expect(t.err()).toContain("error [NOT_FOUND]");
		expect(terminal.started).toBe(false);
	});

	it("rejects unknown flags and --resume combined with new-session flags with exit 2", async () => {
		const h = home(roles);
		const opts = { ...h, models: fauxModels(), stdio: ttyStdio() };
		expect(await runCli(["--bogus"], io(), opts)).toBe(2);
		expect(await runCli(["--resume", "x", "--model", "s2"], io(), opts)).toBe(2);
		expect(await runCli(["--effort", "extreme"], io(), opts)).toBe(2);
	});

	it("opens a session on the fake terminal, then exits 0 on /exit through the exit hook", async () => {
		const h = home(roles);
		const terminal = new FakeTerminal();
		const exit = vi.fn();
		const proc = new EventEmitter();
		const done = runCli([], io(), { ...h, models: fauxModels(), stdio: ttyStdio(), terminal, exit, proc: proc as never });
		await until(() => terminal.started && terminal.output().includes("nexo session"));
		expect(proc.listenerCount("uncaughtException")).toBe(1);
		expect(proc.listenerCount("unhandledRejection")).toBe(1);
		expect(proc.listenerCount("exit")).toBe(1);
		terminal.type("/exit");
		terminal.send(KEY.enter);
		expect(await done).toBe(0);
		expect(exit).toHaveBeenCalledWith(0);
		expect(terminal.stopped).toBe(true);
		expect(proc.listenerCount("uncaughtException")).toBe(0);
		expect(proc.listenerCount("exit")).toBe(0);
	});

	it("aborts through the signal and returns the SIGINT exit code", async () => {
		const h = home(roles);
		const terminal = new FakeTerminal();
		const ac = new AbortController();
		const exit = vi.fn();
		const done = runCli([], io(), { ...h, models: fauxModels(), stdio: ttyStdio(), terminal, exit, signal: ac.signal, proc: new EventEmitter() as never });
		await until(() => terminal.started && terminal.output().includes("nexo session"));
		ac.abort();
		expect(await done).toBe(EXIT_SIGINT);
		expect(exit).toHaveBeenCalledWith(EXIT_SIGINT);
		expect(terminal.stopped).toBe(true);
	});

	it("resumes a session picked by number", async () => {
		const h = home(roles);
		// create a real session first
		const terminal1 = new FakeTerminal();
		const first = runCli([], io(), { ...h, models: fauxModels(), stdio: ttyStdio(), terminal: terminal1, proc: new EventEmitter() as never });
		await until(() => terminal1.started && terminal1.output().includes("nexo session"));
		terminal1.send(KEY.ctrlD);
		await first;
		const db = openDb(resolveNexoPaths(h.env).db);
		const ids = db.prepare("SELECT id FROM sessions").all().map((r) => String(r.id));
		expect(ids).toHaveLength(1);
		const t = io();
		const asked: string[] = [];
		const terminal2 = new FakeTerminal();
		const done = runCli(["--resume"], t, {
			...h,
			models: fauxModels(),
			stdio: ttyStdio(),
			terminal: terminal2,
			proc: new EventEmitter() as never,
			lineAsker: { ask: async (q) => (asked.push(q), "1"), close: () => asked.push("closed") },
		});
		await until(() => terminal2.started && terminal2.output().includes("nexo session"));
		expect(t.err()).toContain(ids[0]);
		expect(asked.at(-1)).toBe("closed");
		terminal2.send(KEY.ctrlD);
		expect(await done).toBe(0);
	});

	it("reports no sessions to resume as NOT_FOUND and treats a blank pick as cancel", async () => {
		const h = home(roles);
		const t = io();
		const code = await runCli(["--resume"], t, { ...h, models: fauxModels(), stdio: ttyStdio(), lineAsker: { ask: async () => "1" } });
		expect(code).toBe(1);
		expect(t.err()).toContain("error [NOT_FOUND]");
		addSession(h, "01SESSIONAAAAAAAAAAAAAAAAA");
		const t2 = io();
		const terminal = new FakeTerminal();
		expect(await runCli(["--resume"], t2, { ...h, models: fauxModels(), stdio: ttyStdio(), terminal, lineAsker: { ask: async () => "" } })).toBe(EXIT_SIGINT);
		expect(terminal.started).toBe(false);
		expect(await runCli(["--resume"], io(), { ...h, models: fauxModels(), stdio: ttyStdio(), terminal, lineAsker: { ask: async () => "9" } })).toBe(2);
	});

	it("routes first run (no config) to the setup screen before the chat", async () => {
		const h = home();
		const terminal = new FakeTerminal();
		const done = runCli([], io(), { ...h, models: fauxModels(), stdio: ttyStdio(), terminal, proc: new EventEmitter() as never });
		await until(() => expect(terminal.output()).toContain("Choose model s1"));
		expect(terminal.output()).not.toContain("nexo session");
		terminal.send(KEY.escape);
		expect(await done).toBe(1);
		expect(terminal.stopped).toBe(true);
	});

	it("keeps CONFIG_INVALID for nexo run without a config", async () => {
		const h = home();
		const t = io();
		expect(await runCli(["run", "x"], t, { ...h, models: fauxModels() })).toBe(2);
		expect(t.err()).toContain("error [CONFIG_INVALID]");
	});
});

describe("crash handlers", () => {
	it("restores the terminal on exit and on uncaught errors, then exits 1", () => {
		const proc = new EventEmitter();
		const restore = vi.fn();
		const exit = vi.fn();
		const t = io();
		const dispose = installCrashHandlers({ proc: proc as never, restore, stderr: t.stderr, exit });
		proc.emit("exit", 0);
		expect(restore).toHaveBeenCalledTimes(1);
		proc.emit("uncaughtException", new Error("boom"));
		expect(restore).toHaveBeenCalledTimes(2);
		expect(t.err()).toContain("boom");
		expect(exit).toHaveBeenCalledWith(1);
		proc.emit("unhandledRejection", "plain reason");
		expect(t.err()).toContain("plain reason");
		expect(exit).toHaveBeenCalledTimes(2);
		dispose();
		expect(proc.eventNames()).toEqual([]);
	});
});

describe("nexo sessions", () => {
	it("lists id, title, turns, cost and updated in aligned columns, newest first", async () => {
		const h = home(roles);
		addSession(h, "01AAAAAAAAAAAAAAAAAAAAAAAA", { title: "first \x1b[31mred\x1b[0m", updatedAt: "2026-10-11T00:01:00.000Z", turns: 12, costUsd: 1.5 });
		addSession(h, "01BBBBBBBBBBBBBBBBBBBBBBBB", { title: "x".repeat(200), updatedAt: "2026-10-11T00:05:00.000Z" });
		const t = io();
		expect(await runCli(["sessions"], t, { ...h, models: fauxModels() })).toBe(0);
		const lines = t.out().trimEnd().split("\n") as [string, string, string];
		expect(lines[0]).toMatch(/^ID\s+TITLE\s+TURNS\s+COST\s+UPDATED$/);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("01BBBB");
		expect(lines[2]).toContain("\\x1b[31mred");
		expect(t.out()).not.toContain("\x1b");
		expect(lines[1]).toContain("…");
		const updated = lines[0].indexOf("UPDATED");
		expect(lines[1].indexOf("2026-10-11")).toBe(updated);
		expect(lines[2].indexOf("2026-10-11")).toBe(updated);
		expect(lines[0].indexOf("COST") + 4).toBe(lines[1].indexOf("$0.2500") + 7);
		expect(lines[2]).toContain("$1.5000");
		expect(lines[2]).toContain("2026-10-11 00:01");
	});

	it("honours --limit and validates it", async () => {
		const h = home(roles);
		addSession(h, "01AAAAAAAAAAAAAAAAAAAAAAAA");
		addSession(h, "01BBBBBBBBBBBBBBBBBBBBBBBB", { updatedAt: "2026-10-11T00:05:00.000Z" });
		const t = io();
		expect(await runCli(["sessions", "--limit", "1"], t, { ...h, models: fauxModels() })).toBe(0);
		expect(t.out().trimEnd().split("\n")).toHaveLength(2);
		for (const bad of ["0", "-1", "abc", "1.5", "1001", ""]) {
			const e = io();
			expect(await runCli(["sessions", "--limit", bad], e, { ...h, models: fauxModels() })).toBe(2);
			expect(e.err()).toContain("--limit");
		}
	});

	it("says so when there are no sessions", async () => {
		const h = home(roles);
		const t = io();
		expect(await runCli(["sessions"], t, { ...h, models: fauxModels() })).toBe(0);
		expect(t.out()).toContain("No sessions");
	});
});

describe("nexo settings", () => {
	it("get and set work without a terminal or a valid config", async () => {
		const h = home();
		const opts = { ...h, models: fauxModels() };
		let t = io();
		expect(await runCli(["settings", "set", "models.s1", "faux/fast"], t, opts)).toBe(0);
		t = io();
		expect(await runCli(["settings", "get", "models.s1"], t, opts)).toBe(0);
		expect(t.out().trim()).toBe("faux/fast");
		t = io();
		expect(await runCli(["settings", "set", "budgets.perRunUsd", "0.75"], t, opts)).toBe(0);
		t = io();
		expect(await runCli(["settings", "get", "budgets.perRunUsd"], t, opts)).toBe(0);
		expect(t.out().trim()).toBe("0.75");
		expect(JSON.parse(readFileSync(join(h.home, "config.json"), "utf8")).budgets.perRunUsd).toBe(0.75);
	});

	it("rejects unknown keys, invalid values and wrong arity with exit 2", async () => {
		const h = home(roles);
		const opts = { ...h, models: fauxModels() };
		for (const argv of [
			["settings", "get", "nope.key"],
			["settings", "set", "nope.key", "1"],
			["settings", "set", "budgets.perRunUsd", "abc"],
			["settings", "set", "budgets.perRunUsd", "-3"],
			["settings", "set", "tools.policy.bash", "maybe"],
			["settings", "set", "budgets.perRunUsd"],
			["settings", "get"],
			["settings", "frobnicate"],
		]) {
			const t = io();
			expect(await runCli(argv, t, opts), argv.join(" ")).toBe(2);
			expect(t.err()).toContain("error [");
		}
	});

	it("opens the settings screen on a terminal and refuses without one", async () => {
		const h = home(roles);
		const t = io();
		expect(await runCli(["settings"], t, { ...h, models: fauxModels(), stdio: pipedStdio("") })).toBe(2);
		expect(t.err()).toContain("interactive terminal");
		const terminal = new FakeTerminal();
		const done = runCli(["settings"], io(), { ...h, models: fauxModels(), stdio: ttyStdio(), terminal, proc: new EventEmitter() as never });
		await until(() => expect(terminal.output()).toMatch(/Model s1\s+faux\/fast/));
		terminal.send(KEY.escape);
		expect(await done).toBe(0);
		expect(terminal.stopped).toBe(true);
	});

	const KEY_TEXT = "sk-test-0123456789abcdef";

	it("set-key reads a piped key from stdin, stores it 0600 and never prints it", async () => {
		const h = home(roles);
		const t = io();
		const code = await runCli(["settings", "set-key", "faux"], t, { ...h, models: fauxModels(), stdio: pipedStdio(`${KEY_TEXT}\n`) });
		expect(code).toBe(0);
		expect(t.out() + t.err()).not.toContain(KEY_TEXT);
		expect(t.out()).toContain("faux");
		const file = join(h.home, "credentials.json");
		expect(JSON.parse(readFileSync(file, "utf8")).faux.apiKey).toBe(KEY_TEXT);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const logs = join(h.home, "logs");
		if (existsSync(logs)) for (const f of readdirSync(logs)) expect(readFileSync(join(logs, f), "utf8")).not.toContain(KEY_TEXT);
	});

	it("set-key refuses a key in argv without echoing it", async () => {
		const h = home(roles);
		const t = io();
		const code = await runCli(["settings", "set-key", "faux", KEY_TEXT], t, { ...h, models: fauxModels(), stdio: pipedStdio(`${KEY_TEXT}\n`) });
		expect(code).toBe(2);
		expect(t.out() + t.err()).not.toContain(KEY_TEXT);
		expect(t.err()).toContain("stdin");
		expect(existsSync(join(h.home, "credentials.json"))).toBe(false);
	});

	it("set-key rejects an empty or invalid key and an unknown provider", async () => {
		const h = home(roles);
		let t = io();
		expect(await runCli(["settings", "set-key", "faux"], t, { ...h, models: fauxModels(), stdio: pipedStdio("\n") })).toBe(2);
		expect(t.err()).toContain("error [INVALID_REQUEST]");
		t = io();
		expect(await runCli(["settings", "set-key", "faux"], t, { ...h, models: fauxModels(), stdio: pipedStdio("short\n") })).toBe(2);
		t = io();
		expect(await runCli(["settings", "set-key", "nosuchprovider"], t, { ...h, models: fauxModels(), stdio: pipedStdio(`${KEY_TEXT}\n`) })).toBe(2);
		expect(t.out() + t.err()).not.toContain(KEY_TEXT);
		expect(await runCli(["settings", "set-key"], io(), { ...h, models: fauxModels(), stdio: pipedStdio("") })).toBe(2);
	});

	it("set-key on a terminal reads without echo (raw mode) and restores it", async () => {
		const h = home(roles);
		const raw: boolean[] = [];
		const stdio = ttyStdio({ setRawMode: (on: boolean) => raw.push(on) });
		const t = io();
		const done = runCli(["settings", "set-key", "faux"], t, { ...h, models: fauxModels(), stdio });
		await until(() => expect(t.err()).toContain("API key for faux"));
		const stdin = stdio.stdin as unknown as PassThrough;
		for (const ch of `${KEY_TEXT}x\x7f`) stdin.write(ch);
		stdin.write("\r");
		expect(await done).toBe(0);
		expect(raw).toEqual([true, false]);
		expect(t.out() + t.err()).not.toContain(KEY_TEXT);
		expect(JSON.parse(readFileSync(join(h.home, "credentials.json"), "utf8")).faux.apiKey).toBe(KEY_TEXT);
	});

	it("set-key on a terminal cancels on Ctrl-C without storing anything", async () => {
		const h = home(roles);
		const stdio = ttyStdio({ setRawMode: () => {} });
		const t = io();
		const done = runCli(["settings", "set-key", "faux"], t, { ...h, models: fauxModels(), stdio });
		await until(() => expect(t.err()).toContain("API key for faux"));
		(stdio.stdin as unknown as PassThrough).write("abc\x03");
		expect(await done).toBe(EXIT_SIGINT);
		expect(existsSync(join(h.home, "credentials.json"))).toBe(false);
	});
});

describe("runtime logger", () => {
	it("redacts a key set through settings in the same process", () => {
		const h = home(roles);
		const runtime = createRuntime({ env: h.env, cwd: h.cwd, models: fauxModels(), prompter: { interactive: false, confirm: async () => false } });
		const secret = "sk-live-9876543210zyxwvu";
		runtime.settings.setKey("faux", secret);
		runtime.logger.info("leak", { value: secret });
		const dir = resolveNexoPaths(h.env).logs;
		const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
		expect(text).toContain("leak");
		expect(text).not.toContain(secret);
	});
});
