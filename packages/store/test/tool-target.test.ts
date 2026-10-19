import { describe, expect, it } from "vitest";
import { parseOptimTarget } from "../src/index.ts";

describe("tool:<name> optimization target", () => {
	it("parses a tool name into a tool_description target", () => {
		expect(parseOptimTarget("tool:read")).toEqual({ key: "tool:read", kind: "tool_description", name: "read" });
		expect(parseOptimTarget("tool:web_fetch")).toEqual({ key: "tool:web_fetch", kind: "tool_description", name: "web_fetch" });
	});

	it("refuses names that are not tool identifiers", () => {
		for (const bad of ["tool:", "tool:Read", "tool:a-b", "tool:1x", "tool:../x", `tool:${"a".repeat(65)}`, "tools:read"]) {
			expect(() => parseOptimTarget(bad), bad).toThrow(/Unknown optimization target/);
		}
	});
});
