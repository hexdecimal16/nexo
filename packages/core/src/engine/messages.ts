import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";

export function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export type RecordedContent =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; redacted?: true }
	| { type: "toolCall"; id: string; name: string; arguments: unknown };

/** What the model said, for the llm_call span: text, thinking and tool calls without provider signatures. */
export function recordedContent(message: AssistantMessage): RecordedContent[] {
	return message.content.map((block): RecordedContent => {
		if (block.type === "text") return { type: "text", text: block.text };
		if (block.type === "thinking") return block.redacted ? { type: "thinking", thinking: block.thinking, redacted: true } : { type: "thinking", thinking: block.thinking };
		return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
	});
}

export function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === "assistant") return m as AssistantMessage;
	}
	return undefined;
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("");
}

/** Returns a copy of `messages` whose last user/toolResult message carries the budget line; other shapes are returned unchanged. */
export function withBudgetLine(messages: AgentMessage[], line: string): AgentMessage[] {
	const last = messages.at(-1);
	if (!last || (last.role !== "user" && last.role !== "toolResult")) return messages;
	const content = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
	const updated = { ...last, content: [...content, { type: "text" as const, text: `\n[nexo] ${line}` }] } as AgentMessage;
	return [...messages.slice(0, -1), updated];
}

const MAX_CALL_ARGS_CHARS = 2000;

/**
 * Gemini 3 rejects a request whose history holds a function call without that model's own thought signature, and
 * pi-ai drops signatures made by any other model. For a Google target, tool calls made by another provider or model
 * (earlier turns on S1, the part of a run before an escalation, a `/model` switch) are sent as text instead: each call
 * becomes a parenthesized "history note" in its assistant message and its result a user message. The wording keeps a model from copying it as text instead of making real function calls (Gemini 4 did that with a bracketed `[tool call ...]` form).
 * The target's own calls stay structured and signed. Other targets get `messages` unchanged.
 */
export function foreignToolCallsAsText(messages: AgentMessage[], target: Pick<Model<Api>, "api" | "provider" | "id">): AgentMessage[] {
	if (!target.api.startsWith("google")) return messages;
	const rewritten = new Set<string>();
	let changed = false;
	const out = messages.map((m): AgentMessage => {
		if (m.role === "assistant") {
			const a = m as AssistantMessage;
			if ((a.provider === target.provider && a.model === target.id) || !a.content.some((b) => b.type === "toolCall")) return m;
			changed = true;
			return {
				...a,
				content: a.content.map((b) => {
					if (b.type !== "toolCall") return b;
					rewritten.add(b.id);
					const args = JSON.stringify(b.arguments ?? {});
					return { type: "text", text: `(history note: an earlier model already ran the ${b.name} tool with ${args.length > MAX_CALL_ARGS_CHARS ? `${args.slice(0, MAX_CALL_ARGS_CHARS)}…` : args}. This is a record, not a format to copy: to use a tool, make a real function call.)` };
				}),
			};
		}
		if (m.role === "toolResult" && rewritten.has((m as ToolResultMessage).toolCallId)) {
			const r = m as ToolResultMessage;
			const [first, ...rest] = r.content;
			const head = `(history note: output of the earlier ${r.toolName} call${r.isError ? ", which failed" : ""}:)`;
			const content = first?.type === "text" ? [{ type: "text" as const, text: `${head}\n${first.text}` }, ...rest] : [{ type: "text" as const, text: head }, ...r.content];
			return { role: "user", content, timestamp: r.timestamp };
		}
		return m;
	});
	return changed ? out : messages;
}

export function estimatePromptChars(messages: readonly AgentMessage[]): number {
	return JSON.stringify(messages).length;
}
