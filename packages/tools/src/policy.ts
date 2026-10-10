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
	authorize(prompter: Prompter, toolName: string, args: unknown, signal?: AbortSignal): Promise<Authorization>;
}

const SUBJECT_KEY: Record<string, string> = { bash: "command", read: "path", write: "path", edit: "path", web_fetch: "url" };

function subjectOf(toolName: string, args: unknown): string {
	const key = SUBJECT_KEY[toolName];
	if (key && typeof args === "object" && args !== null && typeof (args as Record<string, unknown>)[key] === "string") {
		return (args as Record<string, string>)[key] as string;
	}
	return JSON.stringify(args ?? null);
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

	const decide = (toolName: string, args: unknown): PolicyDecision => {
		const subject = subjectOf(toolName, args);
		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i];
			if (rule && rule.tool === toolName && (!rule.re || rule.re.test(subject))) return { action: rule.action, rule: i, subject };
		}
		return { action: cfg.policy[toolName] ?? "ask", subject };
	};

	return {
		decide,
		async authorize(prompter, toolName, args, signal) {
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
			const ok = await prompter.confirm(`Allow ${toolName}: ${decision.subject}?`, signal);
			if (ok) return { allowed: true };
			return {
				allowed: false,
				error: new NexoError({ code: "TOOL_DENIED", message: `User declined ${toolName}: ${decision.subject}`, context: { toolName } }),
			};
		},
	};
}
