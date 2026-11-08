import { describe, expect, it } from "vitest";
import { parseSkillInvocation } from "../src/index.ts";

const names = ["impeccable", "pr-review"];

describe("parseSkillInvocation", () => {
	it("reads /<skill> args as a pinned skill and its instruction", () => {
		expect(parseSkillInvocation("/impeccable init the app", names)).toEqual({ skill: "impeccable", instruction: "init the app" });
		expect(parseSkillInvocation("  /pr-review\nline two ", names)).toEqual({ skill: "pr-review", instruction: "line two" });
	});

	it("accepts /skill:<name> and fills in an instruction when none is given", () => {
		expect(parseSkillInvocation("/skill:impeccable", names)).toEqual({ skill: "impeccable", instruction: "Run the impeccable skill." });
	});

	it("returns null for unknown names, paths and plain text", () => {
		expect(parseSkillInvocation("/unknown do it", names)).toBeNull();
		expect(parseSkillInvocation("/tmp/impeccable", names)).toBeNull();
		expect(parseSkillInvocation("/impeccable/x", names)).toBeNull();
		expect(parseSkillInvocation("use /impeccable", names)).toBeNull();
		expect(parseSkillInvocation("/Impeccable", names)).toBeNull();
	});
});
