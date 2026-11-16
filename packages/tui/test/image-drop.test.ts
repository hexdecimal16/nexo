import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { KEY, until } from "./fake-terminal.ts";
import { startHarness } from "./helpers.ts";

/** A 2×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEUlEQVR4nGP4z8DAwMDAAAAZ8AL+8V3m9wAAAABJRU5ErkJggg==", "base64");

describe("dropping an image into the TUI", () => {
	it("turns the dropped path into a marker and sends the image with the message", async () => {
		const h = await startHarness();
		const file = join(h.cwd, "Screen Shot.png");
		writeFileSync(file, PNG);
		let seen: TranscriptContext | undefined;
		h.faux.setResponses([
			(context) => {
				seen = structuredClone(context);
				return fauxAssistantMessage("A tiny image.");
			},
		]);
		h.terminal.type("what is this ");
		// Terminals deliver a dragged file as a bracketed paste of its (escaped) path.
		h.terminal.send(`\x1b[200~${file.replaceAll(" ", "\\ ")}\x1b[201~`);
		await until(() => expect(h.terminal.output()).toContain("what is this [Image #1]"));
		h.terminal.send(KEY.enter);
		await until(() => expect(h.terminal.output()).toContain("A tiny image."));

		const user = seen!.messages.find((m) => m.role === "user")!;
		const content = user.content as { type: string; text?: string; mimeType?: string }[];
		expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining("what is this [Image #1]") });
		expect(content[0]!.text).toContain("[nexo] Attached images, in order: [Image #1] Screen Shot.png (2×1 PNG).");
		expect(content.filter((b) => b.type === "image")).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
		await until(() => !h.session().running);
		h.terminal.send(KEY.ctrlD);
		await h.done;
	});
});
