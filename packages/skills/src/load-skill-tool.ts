import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Skill, SkillCatalog } from "./loader.ts";

const LoadSkillParams = Type.Object({
	name: Type.String({ description: "Skill name from the skill index" }),
});

export interface LoadSkillToolOptions {
	catalog: SkillCatalog;
	onLoad?: (skill: Skill) => void;
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
			const skill = options.catalog.skills.get(params.name);
			if (!skill) {
				const available = [...options.catalog.skills.keys()].join(", ") || "(none)";
				return {
					content: [{ type: "text", text: `SKILL_NOT_FOUND: Unknown skill "${params.name}". Available: ${available}` }],
					details: { code: "SKILL_NOT_FOUND" },
					isError: true,
				};
			}
			options.onLoad?.(skill);
			return {
				content: [{ type: "text", text: `# Skill: ${skill.name}\nBase directory: ${skill.dir}\n\n${skill.body}${delegationNote(skill)}` }],
				details: { name: skill.name, filePath: skill.filePath },
			};
		},
	};
}
