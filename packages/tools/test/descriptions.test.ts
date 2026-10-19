import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinToolDescriptions, createBuiltinTools, FileLeases } from "../src/index.ts";

describe("builtinToolDescriptions", () => {
	it("returns the description of every built-in tool, as the tools themselves carry it", () => {
		const tools = createBuiltinTools({ workspaceRoot: mkdtempSync(join(tmpdir(), "nexo-desc-")), holder: "t", leases: new FileLeases(), bashTimeoutMs: 1 });
		const descriptions = builtinToolDescriptions();
		expect(Object.keys(descriptions).sort()).toEqual(tools.map((t) => t.name).sort());
		for (const t of tools) expect(descriptions[t.name]).toBe(t.description);
	});
});
