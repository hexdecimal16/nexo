import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createBuiltinTools, FileLeases } from "../src/index.ts";

function setup() {
	const home = mkdtempSync(join(tmpdir(), "nexo-home-"));
	const workspace = join(home, "runs", "r1", "workspace");
	const wikis = join(home, "wikis");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(wikis, "ai"), { recursive: true });
	writeFileSync(join(home, "config.json"), "{}");
	const tools = new Map(
		createBuiltinTools({
			workspaceRoot: workspace,
			holder: "r1",
			leases: new FileLeases(),
			bashTimeoutMs: 5000,
			nexoHome: home,
			runWorkspace: workspace,
			wikiRoots: [wikis],
		}).map((t) => [t.name, t]),
	);
	const tool = (name: string): AgentTool<any> => {
		const t = tools.get(name);
		if (!t) throw new Error(`missing tool ${name}`);
		return t;
	};
	return { home, workspace, wikis, tool };
}

describe("wiki roots", () => {
	it("writes, reads and edits a wiki page by absolute path", async () => {
		const { wikis, tool } = setup();
		const page = join(wikis, "ai", "concepts", "rag.md");
		await tool("write").execute("1", { path: page, content: "---\nsummary: x\n---\nhello" });
		expect(readFileSync(page, "utf8")).toContain("hello");
		await tool("edit").execute("2", { path: page, oldText: "hello", newText: "bye" });
		const read = await tool("read").execute("3", { path: page });
		expect(JSON.stringify(read)).toContain("bye");
	});

	it("still writes workspace files by relative path", async () => {
		const { workspace, tool } = setup();
		await tool("write").execute("1", { path: "a.txt", content: "ok" });
		expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("ok");
	});

	it("denies other nexo home files", async () => {
		const { home, tool } = setup();
		await expect(tool("write").execute("1", { path: join(home, "config.json"), content: "x" })).rejects.toThrow();
		await expect(tool("write").execute("2", { path: join(home, "runs", "r2", "x.txt"), content: "x" })).rejects.toThrow();
		expect(readFileSync(join(home, "config.json"), "utf8")).toBe("{}");
	});

	it("writes and edits files outside the workspace", async () => {
		const { tool } = setup();
		const outside = join(mkdtempSync(join(tmpdir(), "nexo-outside-")), "a.txt");
		await tool("write").execute("1", { path: outside, content: "one" });
		await tool("edit").execute("2", { path: outside, oldText: "one", newText: "two" });
		expect(readFileSync(outside, "utf8")).toBe("two");
	});

	it("denies a dot-dot path that leaves the wikis directory", async () => {
		const { home, wikis, tool } = setup();
		await expect(tool("write").execute("1", { path: join(wikis, "..", "config.json"), content: "x" })).rejects.toThrow();
		expect(readFileSync(join(home, "config.json"), "utf8")).toBe("{}");
	});
});
