import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT, renderSystemPrompt } from "../src/engine/prompts.ts";

describe("renderSystemPrompt", () => {
	it("names the workspace as the place for created files, including skill script output", () => {
		const text = renderSystemPrompt({ systemPrompt: DEFAULT_SYSTEM_PROMPT, plannerPrompt: null, workspace: "/w/run1/workspace", skillIndex: "" });
		expect(text).toContain("Your workspace directory is /w/run1/workspace.");
		expect(text).toContain("save files you create there unless the user names another location");
		expect(text).toContain("run them by absolute path from the workspace instead of changing into their folder");
		expect(text).not.toContain("{{workspace}}");
	});
});
