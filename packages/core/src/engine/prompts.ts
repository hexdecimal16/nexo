export const DEFAULT_SYSTEM_PROMPT = `You are nexo, a general-purpose agent that completes the user's instruction using tools and skills.

Working rules:
- Your workspace directory is {{workspace}}. Use paths relative to it.
- Before following a skill, call load_skill with its name and follow its instructions.
- A budget line is appended to your latest input each turn. Finish within the budget; prefer fewer, larger steps when it is low.
- End with a concise final answer that states what you did and where any output files are.`;

export const DEFAULT_PLANNER_PROMPT = `Parallel work:
- When the instruction has independent parts, call spawn once with all independent tasks so they run in parallel.
- Use dependsOn only when a task needs another task's output; dependency outputs are appended to the dependent task's instruction.
- Choose model "s1" and low effort for simple tasks; use "s2" or higher effort only for hard reasoning. Give each task a clear, self-contained instruction.`;

export interface SystemPromptParts {
	systemPrompt: string;
	plannerPrompt: string | null;
	workspace: string;
	skillIndex: string;
	activeSkill?: { name: string; body: string };
	/** The retrieved-memory data block (`memoryBlock`), last so the rules above it win. */
	memories?: string;
}

export function renderSystemPrompt(parts: SystemPromptParts): string {
	const sections = [parts.systemPrompt.replaceAll("{{workspace}}", parts.workspace)];
	if (parts.plannerPrompt) sections.push(parts.plannerPrompt);
	if (parts.skillIndex) sections.push(parts.skillIndex);
	if (parts.activeSkill) sections.push(`# Active skill: ${parts.activeSkill.name}\n${parts.activeSkill.body}`);
	if (parts.memories) sections.push(parts.memories);
	return sections.join("\n\n");
}
