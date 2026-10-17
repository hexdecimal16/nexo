import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseScratchpad, readScratchpad, scratchpadPagePath, writeScratchpad } from "../src/optimize/scratchpad-wiki.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "nexo-pad-"));
	dirs.push(d);
	return d;
};
const info = { optimRunId: "o1", baseVersion: 3, today: "2026-01-02", redact: (s: string) => s };

describe("scratchpad wiki page", () => {
	it("names one page per target", () => {
		expect(scratchpadPagePath("skill:Web Research")).toBe("analyses/optim-skill-web-research.md");
		expect(scratchpadPagePath("system_prompt")).toBe("analyses/optim-system-prompt.md");
	});

	it("creates the wiki, round-trips both lists and reads hand-added bullets", () => {
		const dir = tmp();
		expect(readScratchpad(dir, "system_prompt")).toBeUndefined();
		const file = writeScratchpad(dir, "system_prompt", { patterns: ["Ask for the path first."], antiPatterns: ["Longer bullet lists."] }, info);
		expect(file.endsWith(join("optimization", "analyses", "optim-system-prompt.md"))).toBe(true);
		for (const f of ["AGENTS.md", "index.md", "log.md", "overview.md"]) expect(existsSync(join(dir, "optimization", f))).toBe(true);
		expect(readFileSync(file, "utf8")).toContain("sources: [optim:o1]");
		expect(readScratchpad(dir, "system_prompt")).toEqual({ patterns: ["Ask for the path first."], antiPatterns: ["Longer bullet lists."] });
		expect(readScratchpad(dir, "planner_prompt")).toBeUndefined();
		appendFileSync(file, "- Added by a person.\n");
		expect(readScratchpad(dir, "system_prompt")?.antiPatterns).toEqual(["Longer bullet lists.", "Added by a person."]);
	});

	it("keeps the newest five entries of a long list and ignores bullets outside the two lists", () => {
		const md = `# Title\n- stray\n\n## Validated patterns\n${[1, 2, 3, 4, 5, 6, 7].map((n) => `- p${n}`).join("\n")}\n\n## Notes\n- ignored\n\n## Anti-patterns\n(none yet)\n`;
		expect(parseScratchpad(md)).toEqual({ patterns: ["p3", "p4", "p5", "p6", "p7"], antiPatterns: [] });
	});
});
