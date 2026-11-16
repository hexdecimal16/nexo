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

/** Images the model keeps seeing; older ones are replaced by a note (Anthropic many-image limits start above 20). */
export const KEEP_RECENT_IMAGES = 8;
/** Older images are dropped only once this many more have built up, so the cached prompt prefix changes rarely. */
const IMAGE_DROP_BATCH = 4;

export const DROPPED_IMAGE_NOTE = "[nexo] Earlier image removed to save context. Read the file again (or ask for it) to see it.";

/**
 * Keeps the newest `keep` images in the conversation and replaces older ones with a short note; the text around them
 * (paths, sizes, the tool calls) stays, so the agent can read an image again. Nothing changes until `keep + batch`
 * images have built up, so a long screenshot-heavy run rewrites its history (and loses its prompt cache) only once
 * every `batch` images.
 */
export function limitImages(messages: AgentMessage[], keep = KEEP_RECENT_IMAGES, batch = IMAGE_DROP_BATCH): { messages: AgentMessage[]; dropped: number } {
	let total = 0;
	for (const m of messages) {
		const content = (m as { content?: unknown }).content;
		if (Array.isArray(content)) for (const block of content) if (block?.type === "image") total++;
	}
	if (total <= keep + batch) return { messages, dropped: 0 };
	let toDrop = total - keep;
	const dropped = toDrop;
	const out = messages.map((m): AgentMessage => {
		const content = (m as { content?: unknown }).content;
		if (toDrop === 0 || !Array.isArray(content) || !content.some((b) => b?.type === "image")) return m;
		const next = content.map((block) => {
			if (toDrop > 0 && block?.type === "image") {
				toDrop--;
				return { type: "text", text: DROPPED_IMAGE_NOTE };
			}
			return block;
		});
		return { ...m, content: next } as AgentMessage;
	});
	return { messages: out, dropped };
}
