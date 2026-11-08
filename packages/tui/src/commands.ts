import type { AutocompleteItem, SlashCommand } from "@earendil-works/pi-tui";
import { EFFORTS } from "@nexo/router";

export interface ParsedCommand {
	name: string;
	args: string;
}

/** `/name args…` → { name, args }; null when the text is not a slash command. */
export function parseSlashCommand(text: string): ParsedCommand | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const match = /^\/(\S*)\s*([\s\S]*)$/.exec(trimmed);
	return { name: match?.[1] ?? "", args: (match?.[2] ?? "").trim() };
}

const items = (values: readonly string[]) => (prefix: string): AutocompleteItem[] | null => {
	const matches = values.filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
	return matches.length > 0 ? matches : null;
};

/** Every slash command, in /help order. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{ name: "help", description: "List the commands" },
	{ name: "done", description: "Mark the last turn done" },
	{ name: "notdone", description: "Mark the last turn not done", argumentHint: "[comment]" },
	{ name: "cost", description: "Show the session's cost and budget" },
	{ name: "queue", description: "List recent runs without a verdict, worst first" },
	{ name: "budget", description: "Set this session's budget cap", argumentHint: "<usd>" },
	{ name: "model", description: "Set this session's model (default clears it)", argumentHint: "<s1|s2|provider/id|default>", getArgumentCompletions: items(["s1", "s2", "default"]) },
	{ name: "effort", description: "Set this session's effort (default clears it)", argumentHint: "<level|default>", getArgumentCompletions: items([...EFFORTS, "default"]) },
	{ name: "auto", description: "Auto mode for this session: an approver model allows in-scope actions", argumentHint: "[on|off|default]", getArgumentCompletions: items(["on", "off", "default"]) },
	{ name: "allow-all", description: "Allow-all mode for this session: auto-approves all tool prompts", argumentHint: "[on|off]", getArgumentCompletions: items(["on", "off"]) },
	{ name: "permissions", description: "List this session's Always-allow rules", argumentHint: "[remove <n>|clear]", getArgumentCompletions: items(["remove", "clear"]) },
	{ name: "compact", description: "Summarize older turns at the start of the next turn" },
	{ name: "clear", description: "Start a new conversation in this session" },
	{ name: "sessions", description: "List recent sessions" },
	{ name: "resume", description: "Switch to another session (a picker when no id is given)", argumentHint: "[id|--all]" },
	{ name: "settings", description: "Open settings (models, keys, budgets, tool policy)" },
	{ name: "exit", description: "Leave nexo (the session can be resumed)" },
];

/** True when `/name` should start a skill turn: `/skill:<name>` always, `/<name>` unless a built-in command has that name. */
export function isSkillCommand(name: string, skills: readonly { name: string }[]): boolean {
	const bare = name.startsWith("skill:") ? name.slice("skill:".length) : name;
	if (!skills.some((s) => s.name === bare)) return false;
	return bare !== name || !SLASH_COMMANDS.some((c) => c.name === name);
}

/** Autocomplete entries for skills; a skill whose name a built-in uses is offered as `/skill:<name>`. */
export function skillSlashCommands(skills: readonly { name: string; description: string }[]): SlashCommand[] {
	return skills.map((s) => ({
		name: SLASH_COMMANDS.some((c) => c.name === s.name) ? `skill:${s.name}` : s.name,
		description: `skill · ${s.description.split("\n")[0]?.slice(0, 120) ?? ""}`,
		argumentHint: "[instruction]",
	}));
}

export function helpText(): string {
	const width = Math.max(...SLASH_COMMANDS.map((c) => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`.length));
	const lines = SLASH_COMMANDS.map((c) => `${`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`.padEnd(width)}  ${c.description ?? ""}`);
	lines.push("", `${"!<command>".padEnd(width)}  Run a shell command; its output goes to the model with your next message`);
	lines.push("", "enter send · shift+enter newline · ↑↓ history · ctrl+o expand tool output · esc/ctrl-c stop a turn · esc twice clears the draft (↑ recalls it) · ctrl-c twice or ctrl-d quit");
	return lines.join("\n");
}
