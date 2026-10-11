import type { Message } from "@earendil-works/pi-ai";
import type { TranscriptLine } from "@nexo/store";

/** Turns kept verbatim when older turns are compacted. */
export const KEEP_VERBATIM_TURNS = 2;

/** Longest session title, in characters. */
export const TITLE_CHARS = 60;

/** Per-message cap on the text sent to the compaction call; tool results get the smaller cap. */
const SUMMARY_MESSAGE_CHARS = 8_000;
const SUMMARY_TOOL_RESULT_CHARS = 2_000;

export const COMPACTION_SYSTEM_PROMPT = `You compress the earlier part of a conversation between a user and nexo, an agent that works with tools in the user's workspace.
Write a concise summary that the agent will read instead of those turns. Keep:
- the user's goals, preferences and constraints;
- decisions made and their reasons;
- files created, changed or read, with their paths;
- important tool results and facts learned;
- open questions and the current state of the work.
Use short bullets. No preamble.`;

/** The user-role message that stands in for compacted turns. */
export function summaryMessage(summary: string, timestamp: number): Message {
	return { role: "user", content: `[nexo] Summary of the earlier conversation (older turns were compacted):\n\n${summary}`, timestamp };
}

export function latestCompaction(lines: readonly TranscriptLine[]): Extract<TranscriptLine, { type: "compaction" }> | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line?.type === "compaction") return line;
	}
	return undefined;
}

/** Message lines still in the active conversation: those after the latest compaction's replaced turns. */
export function activeMessageLines(lines: readonly TranscriptLine[]): Extract<TranscriptLine, { type: "message" }>[] {
	const through = latestCompaction(lines)?.replacedThroughTurn ?? 0;
	return lines.filter((l): l is Extract<TranscriptLine, { type: "message" }> => l.type === "message" && l.turnIndex > through);
}

/** The history the next turn starts from: the latest compaction summary (if any) and every active message. */
export function buildHistory(lines: readonly TranscriptLine[], timestamp: number): Message[] {
	const marker = latestCompaction(lines);
	const messages = activeMessageLines(lines).map((l) => l.message as Message);
	return marker?.summary ? [summaryMessage(marker.summary, timestamp), ...messages] : messages;
}

/** First non-empty line of the first user message, at most TITLE_CHARS characters. */
export function titleFrom(instruction: string): string {
	const line = instruction.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	return line.length > TITLE_CHARS ? line.slice(0, TITLE_CHARS) : line;
}

function cap(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)} […${text.length - max} characters cut]` : text;
}

function blockText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join("");
}

/**
 * Plain-text rendering of turns for the compaction call, at most `maxChars` long: when the turns do not fit, the oldest
 * lines are dropped first (the previous summary is kept, cut to half of `maxChars` if needed).
 */
export function renderForSummary(previousSummary: string, messages: readonly Message[], maxChars = Number.POSITIVE_INFINITY): string {
	const head = previousSummary ? `Summary of the conversation before these turns:\n${cap(previousSummary, Math.floor(maxChars / 2))}\n\n` : "";
	const lines: string[] = [];
	for (const m of messages) {
		if (m.role === "user") lines.push(`[user] ${cap(blockText(m.content), SUMMARY_MESSAGE_CHARS)}`);
		else if (m.role === "toolResult") lines.push(`[tool result ${m.toolName}${m.isError ? " (error)" : ""}] ${cap(blockText(m.content), SUMMARY_TOOL_RESULT_CHARS)}`);
		else if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type === "text" && block.text) lines.push(`[assistant] ${cap(block.text, SUMMARY_MESSAGE_CHARS)}`);
				if (block.type === "toolCall") lines.push(`[assistant calls ${block.name}] ${cap(JSON.stringify(block.arguments), SUMMARY_TOOL_RESULT_CHARS)}`);
			}
		}
	}
	const dropped = "[earlier lines omitted]\n";
	let label = "Turns to summarize:\n";
	let size = head.length + label.length + lines.reduce((sum, l) => sum + l.length + 1, 0);
	let start = 0;
	while (size > maxChars && start < lines.length) {
		size -= (lines[start]?.length ?? 0) + 1;
		start++;
		if (start === 1) {
			label += dropped;
			size += dropped.length;
		}
	}
	return `${head}${label}${lines.slice(start).join("\n")}`.slice(0, Number.isFinite(maxChars) ? maxChars : undefined);
}
