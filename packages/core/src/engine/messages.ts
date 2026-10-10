import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

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

export function estimatePromptChars(messages: readonly AgentMessage[]): number {
	return JSON.stringify(messages).length;
}
