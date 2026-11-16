import { describe, expect, it } from "vitest";
import { ReplyTextExtractor } from "../src/providers/reply-text.ts";

/** Feeds `raw` in pieces of `size` characters and returns what streamed. */
function feed(raw: string, size: number): string {
	const extractor = new ReplyTextExtractor();
	let out = "";
	for (let i = 0; i < raw.length; i += size) out += extractor.push(raw.slice(i, i + size));
	return out;
}

describe("ReplyTextExtractor", () => {
	const reply = { text: 'Line one\n"quoted" \\ tab\there é ☃ 😀 {not json}', tool_calls: [{ name: "bash", arguments: { command: 'echo "text": "no"' } }] };

	it("streams the decoded text field whatever the chunking", () => {
		const escaped = JSON.stringify(reply).replace("é", "\\u00e9").replace("😀", "\\ud83d\\ude00");
		for (const raw of [JSON.stringify(reply), escaped, JSON.stringify(reply, null, 2)]) {
			for (const size of [1, 2, 3, 7, 1000]) expect(feed(raw, size)).toBe(reply.text);
		}
	});

	it("finds text after tool_calls and ignores nested text keys", () => {
		const raw = JSON.stringify({ tool_calls: [{ name: "write", arguments: { text: "nested", path: "a" } }], text: "top" });
		expect(feed(raw, 4)).toBe("top");
	});

	it("skips a code fence, prose and an object without text before the reply", () => {
		expect(feed('Here {it} is:\n```json\n{"text":"hi","tool_calls":[]}\n```', 5)).toBe("hi");
	});

	it("streams only the first text when the reply is written twice", () => {
		const extractor = new ReplyTextExtractor();
		expect(extractor.push('{"text":"one","tool_calls":[]} oops {"text":"two","tool_calls":[]}')).toBe("one");
		expect(extractor.done).toBe(true);
	});

	it("streams nothing when text is not a string", () => {
		expect(feed('{"text":null,"tool_calls":[]}', 3)).toBe("");
	});
});
