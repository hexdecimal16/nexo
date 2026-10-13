import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createRedactor } from "@nexo/telemetry";
import { describe, expect, it } from "vitest";
import { createBuiltinTools, createChangeTracker, FileLeases, MAX_BASH_OUTPUT_BYTES, runBash, type ToolContext, trackedBashGroups } from "../src/index.ts";

const redact = createRedactor();

function setup(overrides: Partial<ToolContext> = {}) {
	const ws = mkdtempSync(join(tmpdir(), "nexo-ws-"));
	const ctx: ToolContext = { workspaceRoot: ws, holder: "run-1", leases: new FileLeases(), bashTimeoutMs: 5000, ...overrides };
	const tools = new Map(createBuiltinTools(ctx).map((t) => [t.name, t]));
	const tool = (name: string): AgentTool<any> => {
		const t = tools.get(name);
		if (!t) throw new Error(`missing tool ${name}`);
		return t;
	};
	return { ws, ctx, tool };
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

describe("read/write/edit", () => {
	it("writes nested files under a lease and reads them back with offset/limit", async () => {
		const { ws, ctx, tool } = setup();
		expect(text(await tool("write").execute("1", { path: "dir/a.txt", content: "l1\nl2\nl3\n" }))).toBe("Wrote 9 bytes to dir/a.txt");
		expect(readFileSync(join(ws, "dir/a.txt"), "utf8")).toBe("l1\nl2\nl3\n");
		expect(ctx.leases.holderOf(join(ws, "dir/a.txt"))).toBeDefined();
		expect(text(await tool("read").execute("2", { path: "dir/a.txt", offset: 2, limit: 1 }))).toBe("l2");
	});

	it("rejects paths outside the workspace", async () => {
		const { tool } = setup();
		await expect(tool("read").execute("1", { path: "../x" })).rejects.toThrow(/outside the workspace/);
	});

	it("rejects writes to files leased by another run", async () => {
		const { ws, ctx, tool } = setup();
		writeFileSync(join(ws, "a.txt"), "x");
		ctx.leases.acquire(join(ws, "a.txt"), "run-2");
		await expect(tool("write").execute("1", { path: "a.txt", content: "y" })).rejects.toThrow(/another task/);
	});

	it("edits a unique match and records the change", async () => {
		const changes = mkdtempSync(join(tmpdir(), "nexo-changes-"));
		const ws = mkdtempSync(join(tmpdir(), "nexo-ws-"));
		writeFileSync(join(ws, "a.txt"), "hello world\n");
		const { tool } = setup({ workspaceRoot: ws, changeTracker: createChangeTracker(ws, changes, redact) });
		await tool("edit").execute("1", { path: "a.txt", oldText: "world", newText: "nexo" });
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("hello nexo\n");
		expect(readFileSync(join(changes, "before", "a.txt"), "utf8")).toBe("hello world\n");
	});

	it("fails edits with zero or multiple matches", async () => {
		const { ws, tool } = setup();
		writeFileSync(join(ws, "a.txt"), "x x");
		await expect(tool("edit").execute("1", { path: "a.txt", oldText: "y", newText: "z" })).rejects.toThrow(/not found/);
		await expect(tool("edit").execute("1", { path: "a.txt", oldText: "x", newText: "z" })).rejects.toThrow(/matches 2 times/);
	});
});

describe("the nexo home", () => {
	/** A workspace (like a user's home directory) that contains the nexo home. */
	function homeSetup() {
		const ws = mkdtempSync(join(tmpdir(), "nexo-userhome-"));
		const nexoHome = join(ws, ".nexo");
		mkdirSync(nexoHome);
		writeFileSync(join(nexoHome, "config.json"), '{"tools":{}}');
		writeFileSync(join(nexoHome, "credentials.json"), '{"faux":"k"}');
		const { tool } = setup({ workspaceRoot: ws, nexoHome });
		return { ws, nexoHome, tool };
	}

	it("denies write and edit inside the nexo home even when the workspace contains it", async () => {
		const { ws, nexoHome, tool } = homeSetup();
		await expect(tool("write").execute("1", { path: ".nexo/config.json", content: "{}" })).rejects.toMatchObject({ code: "TOOL_DENIED", hint: expect.any(String) });
		await expect(tool("write").execute("2", { path: ".nexo/skills/x/SKILL.md", content: "x" })).rejects.toMatchObject({ code: "TOOL_DENIED" });
		await expect(tool("edit").execute("3", { path: ".nexo/config.json", oldText: "{}", newText: "1" })).rejects.toMatchObject({ code: "TOOL_DENIED" });
		// On a case-insensitive file system a different letter case names the same directory.
		if (existsSync(join(ws, ".NEXO"))) await expect(tool("write").execute("5", { path: ".NEXO/config.json", content: "{}" })).rejects.toMatchObject({ code: "TOOL_DENIED" });
		symlinkSync(nexoHome, join(ws, "link"));
		await expect(tool("write").execute("4", { path: "link/config.json", content: "{}" })).rejects.toMatchObject({ code: "TOOL_DENIED" });
		expect(readFileSync(join(nexoHome, "config.json"), "utf8")).toBe('{"tools":{}}');
		expect(existsSync(join(nexoHome, "skills"))).toBe(false);
	});

	it("allows reads inside the nexo home except the credentials file", async () => {
		const { tool } = homeSetup();
		expect(text(await tool("read").execute("1", { path: ".nexo/config.json" }))).toBe('{"tools":{}}');
		await expect(tool("read").execute("2", { path: ".nexo/credentials.json" })).rejects.toMatchObject({ code: "TOOL_DENIED" });
		await expect(tool("read").execute("3", { path: ".nexo/../.nexo/credentials.json" })).rejects.toMatchObject({ code: "TOOL_DENIED" });
	});

	it("leaves other workspace files alone", async () => {
		const { ws, tool } = homeSetup();
		await tool("write").execute("1", { path: "notes.txt", content: "a" });
		await tool("edit").execute("2", { path: "notes.txt", oldText: "a", newText: "b" });
		await tool("write").execute("3", { path: ".nexo-other/x.txt", content: "c" });
		expect(readFileSync(join(ws, "notes.txt"), "utf8")).toBe("b");
		expect(text(await tool("read").execute("4", { path: ".nexo-other/x.txt" }))).toBe("c");
	});

	it("allows writes in the run's own workspace inside the nexo home", async () => {
		const nexoHome = mkdtempSync(join(tmpdir(), "nexo-home-"));
		const ws = join(nexoHome, "runs", "r1", "workspace");
		mkdirSync(ws, { recursive: true });
		const { tool } = setup({ workspaceRoot: ws, nexoHome, runWorkspace: ws });
		await tool("write").execute("1", { path: "a.txt", content: "a" });
		await tool("edit").execute("2", { path: "a.txt", oldText: "a", newText: "b" });
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("b");
	});

	it("denies a workspace inside the nexo home that is not the run's own workspace", async () => {
		const nexoHome = mkdtempSync(join(tmpdir(), "nexo-home-"));
		const own = join(nexoHome, "runs", "r1", "workspace");
		mkdirSync(own, { recursive: true });
		mkdirSync(join(nexoHome, "runs", "r2", "workspace"), { recursive: true });
		mkdirSync(join(nexoHome, "sessions", "s1"), { recursive: true });
		// A run workspace given without saying it is the run's own is not exempt.
		const unnamed = setup({ workspaceRoot: own, nexoHome });
		await expect(unnamed.tool("write").execute("1", { path: "a.txt", content: "a" })).rejects.toMatchObject({ code: "TOOL_DENIED" });
		// A workspace that holds other runs' folders: the own workspace stays writable, the rest is refused.
		const runs = setup({ workspaceRoot: join(nexoHome, "runs"), nexoHome, runWorkspace: own });
		await expect(runs.tool("write").execute("2", { path: "r2/workspace/x.txt", content: "x" })).rejects.toMatchObject({ code: "TOOL_DENIED" });
		await expect(runs.tool("write").execute("3", { path: "r2/run.json", content: "{}" })).rejects.toMatchObject({ code: "TOOL_DENIED" });
		await expect(runs.tool("write").execute("4", { path: "r1/run.json", content: "{}" })).rejects.toMatchObject({ code: "TOOL_DENIED" });
		await runs.tool("write").execute("5", { path: "r1/workspace/ok.txt", content: "ok" });
		expect(readFileSync(join(own, "ok.txt"), "utf8")).toBe("ok");
		expect(existsSync(join(nexoHome, "runs", "r2", "workspace", "x.txt"))).toBe(false);
		// The sessions folder.
		const sessions = setup({ workspaceRoot: join(nexoHome, "sessions"), nexoHome, runWorkspace: own });
		await expect(sessions.tool("write").execute("6", { path: "s1/session.json", content: "{}" })).rejects.toMatchObject({ code: "TOOL_DENIED" });
		expect(existsSync(join(nexoHome, "sessions", "s1", "session.json"))).toBe(false);
	});
});

describe("bash", () => {
	it("runs in the workspace and reports exit codes", async () => {
		const { tool } = setup();
		const ok = await tool("bash").execute("1", { command: "pwd && echo hi" });
		expect(ok.isError).toBeUndefined();
		expect(text(ok)).toContain("exit code: 0");
		expect(text(ok)).toContain("hi");
		const bad = await tool("bash").execute("2", { command: "echo oops >&2; exit 3" });
		expect(bad.isError).toBe(true);
		expect(text(bad)).toContain("exit code: 3");
		expect(text(bad)).toContain("oops");
	});

	it("times out", async () => {
		const { tool } = setup({ bashTimeoutMs: 1000 });
		const r = await tool("bash").execute("1", { command: "sleep 5", timeoutMs: 1000 });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("timed out after 1000ms");
	});

	it("stops on abort", async () => {
		const { tool } = setup();
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const r = await tool("bash").execute("1", { command: "sleep 5" }, ac.signal);
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("aborted");
	});

	it("caps captured output at 1 MB", async () => {
		const { tool } = setup();
		const r = await tool("bash").execute("1", { command: "head -c 3000000 /dev/zero | tr '\\0' 'a'" });
		expect(text(r).length).toBeLessThan(MAX_BASH_OUTPUT_BYTES + 200);
		expect(text(r)).toContain("[output truncated]");
	});
});

describe("bash hardening", () => {
	it("kills the whole process group on timeout and abort", async () => {
		const { tool } = setup();
		const t0 = Date.now();
		const r = await tool("bash").execute("1", { command: "sleep 5; echo x", timeoutMs: 1000 });
		expect(text(r)).toContain("timed out after 1000ms");
		expect(Date.now() - t0).toBeLessThan(2500);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const t1 = Date.now();
		const a = await tool("bash").execute("2", { command: "sleep 5; echo x" }, ac.signal);
		expect(text(a)).toContain("aborted");
		expect(Date.now() - t1).toBeLessThan(2500);
	});

	it("does not run when already aborted", async () => {
		const { ws, tool } = setup();
		const ac = new AbortController();
		ac.abort();
		const r = await tool("bash").execute("1", { command: "touch ran.txt" }, ac.signal);
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("aborted");
		expect(existsSync(join(ws, "ran.txt"))).toBe(false);
	});

	it("marks truncation when a single chunk crosses the cap", async () => {
		const { tool } = setup();
		const r = await tool("bash").execute("1", { command: `head -c ${MAX_BASH_OUTPUT_BYTES + 1} /dev/zero | tr '\\0' 'a'` });
		expect(text(r)).toContain("[output truncated]");
	});
});

describe("runBash", () => {
	it("returns the combined output and exit code of a command run in cwd", async () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-ws-"));
		const r = await runBash({ command: "pwd; echo err >&2; exit 4", cwd: ws, timeoutMs: 5000 });
		expect(r).toMatchObject({ exitCode: 4, truncated: false, ended: "exited" });
		expect(r.output).toContain(ws.split("/").pop());
		expect(r.output).toContain("err");
		expect(trackedBashGroups()).toEqual([]);
	});

	it("reports a timeout and an abort, and does not start when already aborted", async () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-ws-"));
		expect(await runBash({ command: "sleep 5", cwd: ws, timeoutMs: 300 })).toMatchObject({ ended: "timeout", exitCode: null });
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		expect(await runBash({ command: "sleep 5", cwd: ws, timeoutMs: 5000, signal: ac.signal })).toMatchObject({ ended: "aborted", exitCode: null });
		const r = await runBash({ command: "touch ran.txt", cwd: ws, timeoutMs: 5000, signal: ac.signal });
		expect(r.ended).toBe("aborted");
		expect(existsSync(join(ws, "ran.txt"))).toBe(false);
	});

	it("reports a missing cwd as a start failure", async () => {
		const r = await runBash({ command: "echo hi", cwd: join(tmpdir(), "nexo-missing-dir-xyz"), timeoutMs: 5000 });
		expect(r.ended).toBe("failed");
		expect(r.output).toMatch(/ENOENT|no such/i);
	});
});

describe("bash process-group cleanup", () => {
	it("empties the tracked set after a command closes", async () => {
		const { tool } = setup();
		await tool("bash").execute("1", { command: "echo hi" });
		expect(trackedBashGroups()).toEqual([]);
	});

	it("kills live bash groups when the host process exits", async () => {
		const out = execFileSync(process.execPath, [fileURLToPath(new URL("./exit-fixture.ts", import.meta.url))], { encoding: "utf8" });
		const pgid = (JSON.parse(out.trim().split("\n").pop() ?? "[]") as number[])[0] ?? 0;
		expect(pgid).toBeGreaterThan(0);
		await new Promise((r) => setTimeout(r, 300));
		expect(() => process.kill(-pgid, 0)).toThrow(/ESRCH/);
	});
});

describe("edit validation", () => {
	it("rejects empty oldText", async () => {
		const { ws, tool } = setup();
		writeFileSync(join(ws, "a.txt"), "x");
		await expect(tool("edit").execute("1", { path: "a.txt", oldText: "", newText: "z" })).rejects.toThrow(/must not be empty/);
	});
});

describe("web_fetch", () => {
	it("rejects non-http urls", async () => {
		const { tool } = setup();
		await expect(tool("web_fetch").execute("1", { url: "file:///etc/passwd" })).rejects.toThrow(/http/);
	});

	it("returns body text and flags non-2xx as errors", async () => {
		const fakeFetch = (async (url: string) =>
			new Response(url.endsWith("/missing") ? "nope" : "hello", { status: url.endsWith("/missing") ? 404 : 200 })) as typeof fetch;
		const { tool } = setup({ fetch: fakeFetch });
		expect(text(await tool("web_fetch").execute("1", { url: "https://x.test/ok" }))).toBe("hello");
		const missing = await tool("web_fetch").execute("2", { url: "https://x.test/missing" });
		expect(missing.isError).toBe(true);
		expect(text(missing)).toContain("HTTP 404");
	});
});
