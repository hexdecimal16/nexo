import type { OptimTarget } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";

/** A candidate's texts by component name. */
export type ComponentTexts = Record<string, string>;

/** The components of a target, in round-robin order. Every target has exactly one component. */
export function targetComponents(target: OptimTarget): string[] {
	switch (target.kind) {
		case "skill":
			return ["body"];
		case "system_prompt":
			return ["system_prompt"];
		case "planner_prompt":
			return ["planner_prompt"];
		case "judge_rubric":
			return ["rubric"];
	}
}

const SKILL_FILE = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/;

/** A SKILL.md split into its frontmatter (`head`, delimiters included) and its body, as the skill loader splits it. */
export function splitSkillContent(content: string): { head: string; body: string } {
	const match = SKILL_FILE.exec(content);
	if (!match) throw new NexoError({ code: "SKILL_INVALID", message: "The skill artifact has no YAML frontmatter", hint: "Fix the SKILL.md frontmatter, then optimize again" });
	return { head: match[1] as string, body: match[2] as string };
}

/** The component texts of an artifact version of `target`. */
export function textsOf(target: OptimTarget, content: string): ComponentTexts {
	if (target.kind === "skill") return { body: splitSkillContent(content).body };
	return { [targetComponents(target)[0] as string]: content };
}

/** The artifact content for `texts`: a skill keeps the frontmatter of `baseContent`; the others are the text itself. */
export function contentOf(target: OptimTarget, baseContent: string, texts: ComponentTexts): string {
	if (target.kind === "skill") return `${splitSkillContent(baseContent).head}${texts.body ?? ""}`;
	return texts[targetComponents(target)[0] as string] ?? "";
}
