import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createRedactor } from "@nexo/telemetry";
import { describe, expect, it } from "vitest";
import { createBuiltinTools, createChangeTracker, FileLeases, MAX_BASH_OUTPUT_BYTES, type ToolContext } from "../src/index.ts";

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
