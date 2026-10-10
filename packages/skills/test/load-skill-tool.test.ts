import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLoadSkillTool, loadSkills, type Skill } from "../src/index.ts";

describe("load_skill tool", () => {
	const root = mkdtempSync(join(tmpdir(), "nexo-skills-"));
	mkdirSync(join(root, "a"));
	writeFileSync(join(root, "a", "SKILL.md"), "---\nname: a\ndescription: Alpha\n---\nStep 1.\n");
	mkdirSync(join(root, "heavy"));
	writeFileSync(
		join(root, "heavy", "SKILL.md"),
		"---\nname: heavy\ndescription: Heavy\nmetadata:\n  nexo-model: s2\n  nexo-effort: high\n---\nThink hard.\n",
	);
	const catalog = loadSkills([root]);

	it("returns the body and reports the load", async () => {
		const loaded: Skill[] = [];
		const tool = createLoadSkillTool({ catalog, onLoad: (s) => loaded.push(s) });
		const result = await tool.execute("call1", { name: "a" });
		expect(result.isError).toBeUndefined();
		expect(result.content[0]).toEqual({ type: "text", text: `# Skill: a\nBase directory: ${join(root, "a")}\n\nStep 1.\n` });
		expect(loaded.map((s) => s.name)).toEqual(["a"]);
	});

	it("returns an error result for unknown skills", async () => {
		const tool = createLoadSkillTool({ catalog });
		const result = await tool.execute("call2", { name: "zzz" });
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: 'SKILL_NOT_FOUND: Unknown skill "zzz". Available: a, heavy' });
	});

	it("tells the agent to spawn skills that pin a model or effort", async () => {
		const tool = createLoadSkillTool({ catalog });
		const result = await tool.execute("call3", { name: "heavy" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Think hard.\n");
		expect(text).toContain('This skill sets nexo-model "s2" and nexo-effort "high".');
		expect(text).toContain('call spawn with a task whose skill is "heavy"');
	});
});
