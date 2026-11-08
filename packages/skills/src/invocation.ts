/** A `/name args` message that names a skill: the skill to pin and the instruction for the turn. */
export interface SkillInvocation {
	skill: string;
	instruction: string;
}

/** `/name` or `/skill:name`, then optional text; skill names follow the loader's rule (lowercase words joined by `-`). */
const INVOCATION = /^\/(skill:)?([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/;

/**
 * Reads `/impeccable init` as { skill: "impeccable", instruction: "init" } when `impeccable` is one of `names`.
 * `/skill:<name>` always means the skill, so a skill whose name a front end's built-in command uses stays reachable.
 * Returns null for any other text (plain messages, paths like `/tmp/x`, unknown names), which the caller handles as before.
 * With no text after the name, the instruction asks the agent to run the skill.
 */
export function parseSkillInvocation(text: string, names: Iterable<string>): SkillInvocation | null {
	const match = INVOCATION.exec(text.trim());
	if (!match) return null;
	const name = match[2] as string;
	if (![...names].includes(name)) return null;
	const args = (match[3] ?? "").trim();
	return { skill: name, instruction: args || `Run the ${name} skill.` };
}
