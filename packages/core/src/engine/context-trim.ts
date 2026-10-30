import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const CLEARED_TOOL_OUTPUT = "[nexo] Earlier tool output cleared to save context. Run the tool again if you need it.";

/** Tool results shorter than this are left alone: the stub would not save anything. */
const MIN_CLEARABLE_CHARS = 400;

function textLength(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum, block) => sum + (block?.type === "text" && typeof block.text === "string" ? block.text.length : 0), 0);
}

/**
 * Replaces the content of every tool result except the newest `keepRecent` with a short stub. Used mid-run when a
 * request nears the context window: it needs no model call, and the call and its arguments stay in the history.
 */
export function clearOldToolResults(messages: AgentMessage[], keepRecent: number): { messages: AgentMessage[]; cleared: number } {
	const resultIndexes = messages.flatMap((m, i) => (m.role === "toolResult" ? [i] : []));
	const candidates = new Set(resultIndexes.slice(0, Math.max(0, resultIndexes.length - keepRecent)));
	let cleared = 0;
	const out = messages.map((m, i): AgentMessage => {
		if (!candidates.has(i) || textLength((m as { content?: unknown }).content) < MIN_CLEARABLE_CHARS) return m;
		cleared++;
		return { ...m, content: [{ type: "text", text: CLEARED_TOOL_OUTPUT }] } as AgentMessage;
	});
	return { messages: cleared > 0 ? out : messages, cleared };
}
