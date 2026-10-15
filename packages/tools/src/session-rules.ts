/** How a session rule matches later calls (spec §3.2). */
export type SessionRuleKind = "prefix" | "tool" | "host";

/** "Always allow … this session": `prefix` (bash command prefix), `host` (web_fetch URL host) or `tool` (the whole tool). */
export interface SessionRule {
	tool: string;
	kind: SessionRuleKind;
	value?: string;
}

/** Programs whose second word is a subcommand (`git status`), so the prefix includes it. */
const SUBCOMMAND_PROGRAMS = new Set(["git", "npm", "pnpm", "yarn", "npx", "docker", "kubectl", "cargo", "go", "pip", "uv", "gh", "make", "modal"]);
/** Subcommands that run an arbitrary target, so the prefix includes the target too (`pnpm exec vitest`). */
const RUNNERS = new Map<string, Set<string>>([
	["npm", new Set(["run", "exec", "dlx", "x"])],
	["pnpm", new Set(["run", "exec", "dlx", "x"])],
	["yarn", new Set(["run", "exec", "dlx", "x"])],
	["uv", new Set(["run", "tool"])],
	["go", new Set(["run"])],
	["docker", new Set(["run", "exec"])],
	["kubectl", new Set(["exec", "run"])],
	["modal", new Set(["run", "deploy", "serve"])],
]);
/** Subcommands that never get a pattern at all. */
const BLOCKED_SUBCOMMANDS = new Map<string, Set<string>>([["gh", new Set(["api"])]]);
/** Programs that only read or print, so a bare name is a safe prefix (`cat`). Any other bare program gets no pattern. */
const SAFE_SINGLE = new Set([
	"ls", "cat", "pwd", "grep", "rg", "head", "tail", "wc", "echo", "which", "file", "stat", "du", "df", "tree", "diff", "sort", "uniq", "date", "whoami", "uname", "jq", "fd", "true",
]);
/** Interpreters: the prefix is the interpreter plus the script path. */
const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl", "deno", "bun", "sh", "bash", "zsh"]);
/** Commands that change directory or run another command; they never get a pattern. */
const WRAPPERS = new Set(["cd", "sudo", "env", "xargs", "eval", "exec", "nohup", "time", "timeout"]);
/** Chaining, redirection, substitution and newlines: such a command neither gets nor matches a pattern. */
const UNSAFE = /[;&|`<>\n\r]|\$\(/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function words(command: string): string[] {
	return command.trim().split(/\s+/).filter((w) => w.length > 0);
}

function escapeControl(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function stringArg(args: unknown, key: string): string | null {
	if (typeof args !== "object" || args === null) return null;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : null;
}

function urlHost(args: unknown): string | null {
	const raw = stringArg(args, "url");
	if (raw === null) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:" ? url.hostname.toLowerCase() : null;
	} catch {
		return null;
	}
}

/**
 * The prefix "Always allow" offers for a bash command, or null when the command must be approved one by one.
 * Interpreters give the interpreter plus the script; subcommand programs give two words, or three for a runner
 * (`npm run test`, `uv run pytest`) whose target must be present and not a flag; a bare word only for SAFE_SINGLE programs.
 */
export function bashPrefix(command: string): string | null {
	if (UNSAFE.test(command)) return null;
	const w = words(command);
	const [first, second, third] = w;
	if (first === undefined || WRAPPERS.has(first) || ASSIGNMENT.test(first)) return null;
	if (INTERPRETERS.has(first)) return second !== undefined && !second.startsWith("-") ? `${first} ${second}` : null;
	if (SUBCOMMAND_PROGRAMS.has(first)) {
		if (second === undefined || second.startsWith("-") || BLOCKED_SUBCOMMANDS.get(first)?.has(second)) return null;
		if (RUNNERS.get(first)?.has(second)) return third !== undefined && !third.startsWith("-") ? `${first} ${second} ${third}` : null;
		return `${first} ${second}`;
	}
	return SAFE_SINGLE.has(first) ? first : null;
}

/** The rule "Always allow" would add for this call, or null when the box offers only Allow once and Deny. */
export function sessionRuleFor(toolName: string, args: unknown): SessionRule | null {
	if (toolName === "bash") {
		const command = stringArg(args, "command");
		const prefix = command === null ? null : bashPrefix(command);
		return prefix === null ? null : { tool: "bash", kind: "prefix", value: prefix };
	}
	if (toolName === "web_fetch") {
		const host = urlHost(args);
		return host === null ? null : { tool: "web_fetch", kind: "host", value: host };
	}
	return { tool: toolName, kind: "tool" };
}

/** True when `rule` allows this call: same tool, and for bash a whole-word prefix of an unchained command, for web_fetch the same host. */
export function matchesSessionRule(rule: SessionRule, toolName: string, args: unknown): boolean {
	if (rule.tool !== toolName) return false;
	if (rule.kind === "tool") return true;
	if (rule.kind === "host") return rule.value !== undefined && urlHost(args) === rule.value;
	const command = stringArg(args, "command");
	if (command === null || rule.value === undefined || UNSAFE.test(command)) return false;
	const normalized = words(command).join(" ");
	return normalized === rule.value || normalized.startsWith(`${rule.value} `);
}

/** How the box and /permissions name a rule, control characters escaped. */
export function describeSessionRule(rule: SessionRule): string {
	const value = escapeControl(rule.value ?? "");
	if (rule.kind === "prefix") return `\`${value} …\``;
	if (rule.kind === "host") return `${escapeControl(rule.tool)} from ${value}`;
	if (rule.tool === "write" || rule.tool === "edit") return `${rule.tool} in the workspace`;
	return `\`${escapeControl(rule.tool)}\``;
}

export function sameSessionRule(a: SessionRule, b: SessionRule): boolean {
	return a.tool === b.tool && a.kind === b.kind && (a.value ?? null) === (b.value ?? null);
}
