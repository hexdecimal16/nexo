import { describe, expect, it } from "vitest";
import { isSkillCommand, skillSlashCommands } from "../src/commands.ts";

const skills = [
	{ name: "impeccable", description: "Design work\nsecond line" },
	{ name: "help", description: "A skill that clashes with /help" },
];

describe("skill slash commands", () => {
	it("lists skills for autocomplete, moving a clashing name to /skill:<name>", () => {
		const entries = skillSlashCommands(skills);
		expect(entries.map((e) => e.name)).toEqual(["impeccable", "skill:help"]);
		expect(entries[0]?.description).toBe("skill · Design work");
	});

	it("dispatches skills, lets built-ins win and rejects unknown names", () => {
		expect(isSkillCommand("impeccable", skills)).toBe(true);
		expect(isSkillCommand("skill:impeccable", skills)).toBe(true);
		expect(isSkillCommand("help", skills)).toBe(false);
		expect(isSkillCommand("skill:help", skills)).toBe(true);
		expect(isSkillCommand("nope", skills)).toBe(false);
		expect(isSkillCommand("skill:nope", skills)).toBe(false);
	});
});
