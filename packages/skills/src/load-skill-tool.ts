import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Skill, SkillCatalog } from "./loader.ts";

const LoadSkillParams = Type.Object({
	name: Type.String({ description: "Skill name from the skill index" }),
});

export interface LoadSkillToolOptions {
	catalog: SkillCatalog;
	/** The skill as this run uses it (a promoted or candidate body); called before `onLoad` and `appendix`. */
	resolve?: (skill: Skill) => Skill;
	onLoad?: (skill: Skill) => void;
	/** Text appended to the skill body (its playbook and skill memories); an empty string appends nothing. */
	appendix?: (skill: Skill) => string;
}

/** For skills that pin a model or effort: a closing line pointing the agent at `spawn`, which honours that pin. */
function delegationNote(skill: Skill): string {
	const pins: string[] = [];
	if (skill.meta.model !== undefined) pins.push(`nexo-model "${skill.meta.model}"`);
	if (skill.meta.effort !== undefined) pins.push(`nexo-effort "${skill.meta.effort}"`);
	if (pins.length === 0) return "";
	return `\n\nThis skill sets ${pins.join(" and ")}. To run it with that model and effort, call spawn with a task whose skill is "${skill.name}" instead of following it in this conversation.`;
}

export function createLoadSkillTool(options: LoadSkillToolOptions): AgentTool<typeof LoadSkillParams> {
	return {
		name: "load_skill",
		label: "Load skill",
		description: "Load a skill's full instructions by name. Call this before following a skill.",
		parameters: LoadSkillParams,
		execute: async (_toolCallId, params) => {
			const found = options.catalog.skills.get(params.name);
			const skill = found && options.resolve ? options.resolve(found) : found;
			if (!skill) {
				const available = [...options.catalog.skills.keys()].join(", ") || "(none)";
				return {
					content: [{ type: "text", text: `SKILL_NOT_FOUND: Unknown skill "${params.name}". Available: ${available}` }],
					details: { code: "SKILL_NOT_FOUND" },
					isError: true,
				};
			}
			options.onLoad?.(skill);
			const extra = options.appendix?.(skill) ?? "";
			return {
				content: [{ type: "text", text: `# Skill: ${skill.name}\nBase directory: ${skill.dir}\n\n${skill.body}${extra ? `\n\n${extra}` : ""}${delegationNote(skill)}` }],
				details: { name: skill.name, filePath: skill.filePath },
			};
		},
	};
}
