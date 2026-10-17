import { describe, expect, it } from "vitest";
import { resolveNexoPaths } from "@nexo/store";
import { DEFAULT_SYSTEM_PROMPT, renderSystemPrompt, wikiPrompt } from "../src/engine/prompts.ts";

const base = { systemPrompt: DEFAULT_SYSTEM_PROMPT, plannerPrompt: null, workspace: "/w", skillIndex: "" };

describe("wiki prompt", () => {
	it("names the wikis directory and points at the wiki skill when set", () => {
		const out = renderSystemPrompt({ ...base, wikisDir: "/home/u/.nexo/wikis" });
		expect(out).toContain(wikiPrompt("/home/u/.nexo/wikis"));
		expect(out).toContain("/home/u/.nexo/wikis");
		expect(out).toContain("load_skill");
	});

	it("adds nothing when no wikis directory is given", () => {
		expect(renderSystemPrompt(base)).not.toContain("Wikis:");
	});

	it("puts the wikis directory under the nexo home", () => {
		const paths = resolveNexoPaths({ NEXO_HOME: "/tmp/nexo-x" });
		expect(paths.wikis).toBe("/tmp/nexo-x/wikis");
	});
});
