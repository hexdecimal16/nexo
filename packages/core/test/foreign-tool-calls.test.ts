import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/google-shared";
import { describe, expect, it } from "vitest";
import { foreignToolCallsAsText } from "../src/engine/messages.ts";

const PRO = { id: "gemini-3.1-pro-preview", provider: "google-vertex", api: "google-vertex", input: ["text", "image"], reasoning: true } as unknown as Model<Api>;
const CLAUDE = { id: "claude-x", provider: "anthropic", api: "anthropic-messages", input: ["text"], reasoning: true } as unknown as Model<Api>;
const SIG = "c2lnbmF0dXJlLWJ5dGVz";

function assistant(model: string, calls: { id: string; name: string; args: Record<string, unknown> }[], text = ""): AssistantMessage {
	return {
		role: "assistant",
		content: [...(text ? [{ type: "text" as const, text }] : []), ...calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.args, thoughtSignature: SIG }))],
		api: "google-vertex",
		provider: "google-vertex",
		model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1,
	} as AssistantMessage;
}

function result(id: string, name: string, text: string, isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 1 };
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

/** Function calls in the Gemini request that carry no thought signature. */
function unsignedCalls(messages: AgentMessage[], model: Model<Api>): unknown[] {
	const contents = convertMessages(model as never, { messages: messages as Message[] } as never) as { parts: { functionCall?: unknown; thoughtSignature?: string }[] }[];
	return contents.flatMap((c) => c.parts).filter((p) => p.functionCall && !p.thoughtSignature);
}

describe("foreignToolCallsAsText", () => {
	const history: AgentMessage[] = [
		user("list files"),
		assistant("gemini-3.5-flash-lite", [{ id: "c1", name: "bash", args: { command: "ls" } }], "Looking."),
		result("c1", "bash", "a.txt\nb.txt"),
		assistant("gemini-3.5-flash-lite", [{ id: "c2", name: "read", args: { path: "a.txt" } }]),
		result("c2", "read", "ENOENT", true),
		user("now migrate"),
	];

	it("reproduces the failure: another Gemini model's calls reach the request unsigned", () => {
		expect(unsignedCalls(history, PRO)).toHaveLength(2);
	});

	it("turns another model's tool calls and results into text for a Google target", () => {
		const out = foreignToolCallsAsText(history, PRO);
		expect(unsignedCalls(out, PRO)).toEqual([]);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "user"]);
		expect(out[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "text", text: '[tool call bash {"command":"ls"}]' }] });
		expect(out[2]).toMatchObject({ role: "user", content: [{ type: "text", text: "[tool result bash]\na.txt\nb.txt" }] });
		expect(out[4]).toMatchObject({ content: [{ type: "text", text: "[tool result read (error)]\nENOENT" }] });
		expect(history[1]).toMatchObject({ content: [{ type: "text" }, { type: "toolCall" }] });
	});

	it("keeps the target model's own calls structured and signed", () => {
		const own: AgentMessage[] = [user("q"), assistant(PRO.id, [{ id: "c9", name: "bash", args: { command: "pwd" } }]), result("c9", "bash", "/w")];
		const out = foreignToolCallsAsText(own, PRO);
		expect(out).toEqual(own);
		expect(unsignedCalls(out, PRO)).toEqual([]);
	});

	it("rewrites only the foreign part of a mixed history", () => {
		const mixed: AgentMessage[] = [...history, assistant(PRO.id, [{ id: "c3", name: "bash", args: { command: "pwd" } }]), result("c3", "bash", "/w")];
		const out = foreignToolCallsAsText(mixed, PRO);
		expect(out.at(-2)).toEqual(mixed.at(-2));
		expect(out.at(-1)).toEqual(mixed.at(-1));
		expect(unsignedCalls(out, PRO)).toEqual([]);
	});

	it("leaves non-Google targets untouched", () => {
		expect(foreignToolCallsAsText(history, CLAUDE)).toBe(history);
	});

	it("keeps images in rewritten results and truncates long call arguments", () => {
		const big = "x".repeat(5000);
		const out = foreignToolCallsAsText(
			[
				assistant("other", [{ id: "c1", name: "write", args: { content: big } }]),
				{ role: "toolResult", toolCallId: "c1", toolName: "write", content: [{ type: "text", text: "ok" }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false, timestamp: 1 },
			],
			PRO,
		);
		const callText = (out[0] as AssistantMessage).content[0] as { text: string };
		expect(callText.text.length).toBeLessThan(2100);
		expect(callText.text).toMatch(/…\]$/);
		expect(out[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "[tool result write]\nok" }, { type: "image", mimeType: "image/png" }] });
	});
});
