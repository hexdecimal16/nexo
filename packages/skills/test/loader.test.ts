import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatSkillIndex, loadSkills } from "../src/index.ts";

function writeSkill(root: string, dirName: string, frontmatter: string, body = "Do the thing.") {
	mkdirSync(join(root, dirName), { recursive: true });
	writeFileSync(join(root, dirName, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}

describe("loadSkills", () => {
	it("parses a valid skill with default nexo metadata", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-skills-"));
		writeSkill(root, "summarize", "name: summarize\ndescription: Summarize documents");
		const { skills, diagnostics } = loadSkills([root]);
		expect(diagnostics).toEqual([]);
		expect(skills.get("summarize")).toMatchObject({
			name: "summarize",
			description: "Summarize documents",
			body: "Do the thing.\n",
			meta: { modelAllowed: ["s1", "s2"], escalate: true, parallelSafe: true },
		});
	});

	it("parses nexo metadata", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-skills-"));
		writeSkill(
			root,
			"report",
			[
				"name: report",
				"description: Build a report",
				"metadata:",
				"  nexo-model: s2",
				"  nexo-effort: medium",
				'  nexo-model-allowed: "s2, faux/slow"',
				'  nexo-escalate: "false"',
				'  nexo-parallel-safe: "false"',
				"  nexo-scorers: scorers.json",
			].join("\n"),
		);
		expect(loadSkills([root]).skills.get("report")?.meta).toEqual({
			model: "s2",
			effort: "medium",
			modelAllowed: ["s2", "faux/slow"],
			escalate: false,
			parallelSafe: false,
			scorers: "scorers.json",
		});
	});

	it.each([
		["bad name", "Bad_Name", "name: Bad_Name\ndescription: x"],
		["name/dir mismatch", "dir-a", "name: other\ndescription: x"],
		["missing description", "nodesc", "name: nodesc"],
		["description too long", "long", `name: long\ndescription: ${"x".repeat(1025)}`],
		["bad effort", "eff", "name: eff\ndescription: x\nmetadata:\n  nexo-effort: extreme"],
		["bad boolean", "boo", 'name: boo\ndescription: x\nmetadata:\n  nexo-escalate: "yes"'],
		["non-string metadata", "num", "name: num\ndescription: x\nmetadata:\n  nexo-effort: 3"],
		["broken yaml", "yml", "name: [unclosed"],
	])("reports %s as SKILL_INVALID and skips it", (_label, dir, fm) => {
		const root = mkdtempSync(join(tmpdir(), "nexo-skills-"));
		writeSkill(root, dir, fm);
		const { skills, diagnostics } = loadSkills([root]);
		expect(skills.size).toBe(0);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.error.code).toBe("SKILL_INVALID");
	});

	it("later dirs override earlier ones; missing dirs and dirs without SKILL.md are ignored", () => {
		const a = mkdtempSync(join(tmpdir(), "nexo-skills-"));
		const b = mkdtempSync(join(tmpdir(), "nexo-skills-"));
		writeSkill(a, "s", "name: s\ndescription: from a");
		writeSkill(b, "s", "name: s\ndescription: from b");
		mkdirSync(join(b, "empty"));
		const { skills, diagnostics } = loadSkills([a, join(a, "missing"), b]);
		expect(skills.get("s")?.description).toBe("from b");
		expect(diagnostics).toEqual([]);
	});

	it("formats a one-level index", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-skills-"));
		writeSkill(root, "a", "name: a\ndescription: Alpha");
		expect(formatSkillIndex(loadSkills([root]))).toBe("Available skills (call load_skill before using one):\n- a: Alpha");
		expect(formatSkillIndex({ skills: new Map(), diagnostics: [] })).toBe("");
	});
});
