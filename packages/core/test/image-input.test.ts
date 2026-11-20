import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DROPPED_IMAGE_NOTE, limitImages } from "../src/engine/context-trim.ts";
import { estimatePromptChars, IMAGE_ESTIMATE_CHARS } from "../src/engine/messages.ts";
import { AGY_P_PROVIDER, agyPProvider, type AgyPRunner, CLAUDE_P_PROVIDER, claudePProvider, type ClaudePRequest, CODEX_P_PROVIDER, codexPProvider, type CodexPRequest, expandMentions, renderTranscriptParts } from "../src/index.ts";

/** A 2×1 PNG: valid header, so the image helpers accept it. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEUlEQVR4nGP4z8DAwMDAAAAZ8AL+8V3m9wAAAABJRU5ErkJggg==", "base64");
const img = (data = "AAAA") => ({ type: "image" as const, data, mimeType: "image/png" });

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const userWithImage: Message = { role: "user", content: [{ type: "text", text: "What color?" }, img("QUJD")], timestamp: 1 };

describe("renderTranscriptParts", () => {
	it("keeps images in place in a tagged transcript", () => {
		const parts = renderTranscriptParts([
			{ role: "user", content: "look", timestamp: 1 },
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "Image a.png:" }, img()], isError: false, timestamp: 2 },
		]);
		expect(parts.map((p) => p.type)).toEqual(["text", "image", "text"]);
		expect(parts[0]).toMatchObject({ type: "text", text: expect.stringContaining('<tool_result id="c1" name="read">\nImage a.png:\n') });
		expect(parts[2]).toMatchObject({ type: "text", text: expect.stringContaining("</tool_result>") });
	});
});

describe("claude-p images", () => {
	it("sends a prompt with images as a stream-json user message", async () => {
		const requests: ClaudePRequest[] = [];
		const run = (request: ClaudePRequest) => {
			requests.push(request);
			return {
				lines: (async function* () {
					yield JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Red.", usage: {} });
				})(),
				exit: Promise.resolve({ code: 0, stderr: "" }),
			};
		};
		const models = createModels();
		models.setProvider(claudePProvider({ run }));
		const model = models.getModel(CLAUDE_P_PROVIDER, "haiku")!;
		expect(model.input).toContain("image");
		const msg = await models.completeSimple(model, { messages: [userWithImage] });
		expect(msg.content).toEqual([{ type: "text", text: "Red." }]);

		const req = requests[0]!;
		expect(req.args[req.args.indexOf("--input-format") + 1]).toBe("stream-json");
		expect(JSON.parse(req.stdin)).toEqual({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: "What color?\n" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] },
		});
	});
});

describe("codex-p images", () => {
	it("attaches images as files with --image and marks them in the prompt", async () => {
		const requests: CodexPRequest[] = [];
		const files: { path: string; bytes: string }[] = [];
		const run = (request: CodexPRequest) => {
			requests.push(request);
			for (const arg of request.args) if (arg.startsWith("--image=")) files.push({ path: arg.slice(8), bytes: readFileSync(arg.slice(8)).toString() });
			return {
				lines: (async function* () {
					for (const l of [
						{ type: "thread.started", thread_id: "t1" },
						{ type: "item.completed", item: { id: "i", type: "agent_message", text: "Red." } },
						{ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
					])
						yield JSON.stringify(l);
				})(),
				exit: Promise.resolve({ code: 0, stderr: "" }),
			};
		};
		const models = createModels();
		models.setProvider(codexPProvider({ run, catalog: async () => ({ models: [{ slug: "gpt-6-astra", base_instructions: "x" }] }) }));
		const model = models.getModel(CODEX_P_PROVIDER, "gpt-6-astra")!;
		expect(model.input).toContain("image");
		await models.completeSimple(model, { messages: [userWithImage] });

		expect(files).toHaveLength(1);
		expect(files[0]!.path).toMatch(/image-1\.png$/);
		expect(files[0]!.bytes).toBe("ABC");
		expect(requests[0]!.stdin).toBe("What color?\n[attached image 1 of 1]");
		expect(requests[0]!.args.at(-1)).toBe("-");
	});
});

describe("agy-p images", () => {
	it("sends images as ACP image content blocks", async () => {
		const promptBlocks: unknown[][] = [];
		const run: AgyPRunner = () => {
			const out: string[] = [];
			let notify: (() => void) | undefined;
			let done = false;
			let resolveExit!: (r: { code: number | null; stderr: string }) => void;
			const exit = new Promise<{ code: number | null; stderr: string }>((r) => {
				resolveExit = r;
			});
			const emit = (m: object) => {
				out.push(JSON.stringify({ jsonrpc: "2.0", ...m }));
				notify?.();
			};
			const lines = (async function* () {
				while (true) {
					if (out.length) {
						yield out.shift()!;
						continue;
					}
					if (done) return;
					await new Promise<void>((r) => {
						notify = r;
					});
					notify = undefined;
				}
			})();
			return {
				write: (line: string) => {
					const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, any> };
					if (msg.method === "initialize") emit({ id: msg.id, result: { protocolVersion: 1 } });
					else if (msg.method === "session/new") emit({ id: msg.id, result: { sessionId: "s1", configOptions: [] } });
					else if (msg.method === "session/set_config_option" || msg.method === "session/close") emit({ id: msg.id, result: {} });
					else if (msg.method === "session/prompt") {
						promptBlocks.push(msg.params!.prompt);
						queueMicrotask(() => {
							emit({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Red." } } } });
							emit({ id: msg.id, result: { stopReason: "end_turn" } });
						});
					}
				},
				lines,
				exit,
				kill: () => {
					done = true;
					resolveExit({ code: null, stderr: "" });
					notify?.();
				},
			};
		};
		const models = createModels();
		models.setProvider(agyPProvider({ run }));
		const model = models.getModel(AGY_P_PROVIDER, "gemini-3.8-flash")!;
		expect(model.input).toContain("image");
		const msg = await models.completeSimple(model, { messages: [userWithImage] });
		expect(msg.content).toEqual([{ type: "text", text: "Red." }]);
		expect(promptBlocks[0]).toEqual([
			{ type: "text", text: "What color?\n" },
			{ type: "image", data: "QUJD", mimeType: "image/png" },
		]);
	});
});

describe("limitImages", () => {
	const shot = (i: number): AgentMessage => ({ role: "toolResult", toolCallId: `c${i}`, toolName: "screenshot", content: [{ type: "text", text: `shot ${i}` }, img(String(i))], isError: false, timestamp: i }) as AgentMessage;

	it("leaves the history alone until keep + batch images have built up", () => {
		const messages = Array.from({ length: 6 }, (_, i) => shot(i));
		expect(limitImages(messages, 4, 2).messages).toBe(messages);
	});

	it("replaces the oldest images with a note, keeping the newest and the text", () => {
		const messages = Array.from({ length: 7 }, (_, i) => shot(i));
		const { messages: out, dropped } = limitImages(messages, 4, 2);
		expect(dropped).toBe(3);
		const content = (i: number) => (out[i] as { content: { type: string; text?: string }[] }).content;
		expect(content(0)).toEqual([{ type: "text", text: "shot 0" }, { type: "text", text: DROPPED_IMAGE_NOTE }]);
		expect(content(2)[1]).toEqual({ type: "text", text: DROPPED_IMAGE_NOTE });
		expect(content(3)[1]).toMatchObject({ type: "image", data: "3" });
		expect(content(6)[1]).toMatchObject({ type: "image", data: "6" });
	});
});

describe("estimatePromptChars", () => {
	it("counts an image at a flat estimate, not its base64 length", () => {
		const big = [{ role: "user", content: [img("A".repeat(1_000_000))], timestamp: 1 }] as AgentMessage[];
		const small = [{ role: "user", content: [img("A")], timestamp: 1 }] as AgentMessage[];
		expect(estimatePromptChars(big)).toBe(estimatePromptChars(small));
		expect(estimatePromptChars(big)).toBeGreaterThan(IMAGE_ESTIMATE_CHARS);
		expect(estimatePromptChars(big)).toBeLessThan(IMAGE_ESTIMATE_CHARS + 200);
	});
});

describe("expandMentions images", () => {
	it("attaches an @-mentioned image as an image and names it in the text", () => {
		const dir = mkdtempSync(join(tmpdir(), "nexo-img-mention-"));
		dirs.push(dir);
		writeFileSync(join(dir, "shot.png"), PNG);
		const out = expandMentions("what is in @shot.png?", dir);
		expect(out.images).toHaveLength(1);
		expect(out.images[0]).toMatchObject({ type: "image", mimeType: "image/png", data: PNG.toString("base64") });
		expect(out.files).toEqual(["shot.png"]);
		expect(out.text).toBe("what is in @shot.png?\n\n[nexo] Images attached with @, in order: shot.png (2×1 PNG).");
	});
});
