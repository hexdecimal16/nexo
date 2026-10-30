import { describe, expect, it } from "vitest";
import { CLEARED_TOOL_OUTPUT, clearOldToolResults } from "../src/engine/context-trim.ts";

const result = (content: unknown) => ({ role: "toolResult", toolCallId: "t", toolName: "read", content, isError: false, timestamp: 0 }) as never;
const text = (s: string) => [{ type: "text", text: s }];
const firstText = (m: unknown) => (m as { content: { text?: string }[] }).content[0]?.text;

describe("clearOldToolResults edge cases", () => {
	it("clears nothing when keepRecent covers every result", () => {
		const messages = [result(text("x".repeat(1000))), result(text("x".repeat(1000)))];
		expect(clearOldToolResults(messages, 5)).toEqual({ messages, cleared: 0 });
	});

	it("clears string content as well as block content", () => {
		const out = clearOldToolResults([result("s".repeat(1000)), result(text("new"))], 1);
		expect(out.cleared).toBe(1);
		expect(firstText(out.messages[0])).toBe(CLEARED_TOOL_OUTPUT);
	});

	it("leaves results under 400 characters and clears ones of exactly 400", () => {
		const out = clearOldToolResults([result(text("a".repeat(399))), result(text("b".repeat(400))), result(text("new"))], 1);
		expect(out.cleared).toBe(1);
		expect(firstText(out.messages[0])).toBe("a".repeat(399));
		expect(firstText(out.messages[1])).toBe(CLEARED_TOOL_OUTPUT);
	});

	it("replaces a cleared result's image blocks too, leaving one text block", () => {
		const out = clearOldToolResults([result([...text("t".repeat(500)), { type: "image", data: "AAAA", mimeType: "image/png" }]), result(text("new"))], 1);
		expect((out.messages[0] as unknown as { content: unknown[] }).content).toEqual([{ type: "text", text: CLEARED_TOOL_OUTPUT }]);
	});

	it("counts only text toward the size, so an image-only result is kept", () => {
		const img = result([{ type: "image", data: "A".repeat(5000), mimeType: "image/png" }]);
		expect(clearOldToolResults([img, result(text("new"))], 1).cleared).toBe(0);
	});

	it("handles an empty history and a negative keepRecent", () => {
		expect(clearOldToolResults([], 4)).toEqual({ messages: [], cleared: 0 });
		expect(clearOldToolResults([result(text("x".repeat(500)))], -1).cleared).toBe(1);
	});
});
