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
	{ name: "budget", description: "Set this session's budget cap", argumentHint: "<usd>" },
	{ name: "model", description: "Set this session's model (default clears it)", argumentHint: "<s1|s2|provider/id|default>", getArgumentCompletions: items(["s1", "s2", "default"]) },
	{ name: "effort", description: "Set this session's effort (default clears it)", argumentHint: "<level|default>", getArgumentCompletions: items([...EFFORTS, "default"]) },
	{ name: "auto", description: "Auto mode for this session: an approver model allows in-scope actions", argumentHint: "[on|off|default]", getArgumentCompletions: items(["on", "off", "default"]) },
	{ name: "permissions", description: "List this session's Always-allow rules", argumentHint: "[remove <n>|clear]", getArgumentCompletions: items(["remove", "clear"]) },
	{ name: "compact", description: "Summarize older turns at the start of the next turn" },
	{ name: "clear", description: "Start a new conversation in this session" },
	{ name: "sessions", description: "List recent sessions" },
	{ name: "settings", description: "Open settings (models, keys, budgets, tool policy)" },
	{ name: "exit", description: "Leave nexo (the session can be resumed)" },
];

export function helpText(): string {
	const width = Math.max(...SLASH_COMMANDS.map((c) => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`.length));
	const lines = SLASH_COMMANDS.map((c) => `${`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`.padEnd(width)}  ${c.description ?? ""}`);
	lines.push("", `${"!<command>".padEnd(width)}  Run a shell command; its output goes to the model with your next message`);
	lines.push("", "enter send · shift+enter newline · ↑↓ history · ctrl+o expand tool output · esc/ctrl-c stop a turn · ctrl-c twice or ctrl-d quit");
	return lines.join("\n");
}
