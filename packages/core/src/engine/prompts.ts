export const DEFAULT_SYSTEM_PROMPT = `You are nexo, a general-purpose agent that completes the user's instruction using tools and skills.

Working rules:
- Your workspace directory is {{workspace}}. Use paths relative to it, and save files you create there unless the user names another location.
- A skill's scripts and project files may live elsewhere: run them by absolute path from the workspace instead of changing into their folder, and point their output into the workspace.
- Before following a skill, call load_skill with its name and follow its instructions.
- Make independent tool calls in the same turn, and combine related shell steps into one command. To read several files, pass paths to one read call.
- Scope searches to a directory, never find /. Start a command that may outlive the bash timeout in the background (nohup ... > job.log 2>&1 &) and poll the log.
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
	/** The directory holding the user wikis; a line naming it is added when set. */
	wikisDir?: string;
	skillIndex: string;
	/** The project's AGENTS.md / CLAUDE.md data block (`loadProjectInstructions`); empty or absent adds nothing. */
	projectInstructions?: string;
	activeSkill?: { name: string; body: string };
	/** The retrieved-memory data block (`memoryBlock`), last so the rules above it win. */
	memories?: string;
}

/** The line that points the agent at the wikis directory; the wiki skill holds the rules for using it. */
export function wikiPrompt(wikisDir: string): string {
	return `Wikis: the user keeps persistent knowledge bases as markdown folders under ${wikisDir}. When a task produces durable subject knowledge worth keeping (research findings, a source you read, a topic the user keeps returning to), load the wiki skill with load_skill and file it in the wiki that fits, creating a new wiki when none fits. Do not create or edit wikis for one-off questions, small talk or routine code changes. Load the wiki skill first whenever the task is about a wiki.`;
}

export function renderSystemPrompt(parts: SystemPromptParts): string {
	const sections = [parts.systemPrompt.replaceAll("{{workspace}}", parts.workspace)];
	if (parts.plannerPrompt) sections.push(parts.plannerPrompt);
	if (parts.wikisDir) sections.push(wikiPrompt(parts.wikisDir));
	if (parts.skillIndex) sections.push(parts.skillIndex);
	if (parts.activeSkill) sections.push(`# Active skill: ${parts.activeSkill.name}\n${parts.activeSkill.body}`);
	if (parts.projectInstructions) sections.push(parts.projectInstructions);
	if (parts.memories) sections.push(parts.memories);
	return sections.join("\n\n");
}
