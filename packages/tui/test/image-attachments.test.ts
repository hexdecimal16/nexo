import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { findDroppedImagePaths, ImageAttachments, imageMarker, withImageLabels } from "../src/image-attachments.ts";

/** A 2×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEUlEQVR4nGP4z8DAwMDAAAAZ8AL+8V3m9wAAAABJRU5ErkJggg==", "base64");

function images() {
	const dir = mkdtempSync(join(tmpdir(), "nexo-drop-"));
	mkdirSync(join(dir, "My Shots"));
	const spaced = join(dir, "My Shots", "Screen Shot 1.png");
	const plain = join(dir, "frame.png");
	writeFileSync(spaced, PNG);
	writeFileSync(plain, PNG);
	writeFileSync(join(dir, "notes.png"), "not an image");
	return { dir, spaced, plain };
}

describe("findDroppedImagePaths", () => {
	it("finds escaped, quoted and file:// paths the way terminals paste dropped files", () => {
		const { spaced, plain } = images();
		const escaped = spaced.replaceAll(" ", "\\ ");
		const text = `compare ${escaped} with '${spaced}' and "${plain}" and ${pathToFileURL(plain).href}`;
		const found = findDroppedImagePaths(text);
		expect(found.map((f) => f.path)).toEqual([spaced, spaced, plain, plain]);
		expect(text.slice(found[0]!.start, found[0]!.end)).toBe(escaped);
		expect(text.slice(found[1]!.start, found[1]!.end)).toBe(`'${spaced}'`);
	});

	it("ignores relative paths, @ mentions, missing files and files that are not images", () => {
		const { dir } = images();
		const text = `see frame.png @frame.png ${join(dir, "missing.png")} ${join(dir, "notes.png")} ${join(dir, "frame.txt")}`;
		expect(findDroppedImagePaths(text)).toEqual([]);
	});
});

describe("ImageAttachments", () => {
	it("turns dropped paths into markers and resolves the markers a message keeps, in order", () => {
		const { spaced, plain } = images();
		const attachments = new ImageAttachments();
		const replaced = attachments.replaceDroppedPaths(`a ${spaced.replaceAll(" ", "\\ ")} b ${plain}`)!;
		expect(replaced.text).toBe(`a ${imageMarker(1)} b ${imageMarker(2)}`);
		expect(replaced.attached).toEqual([imageMarker(1), imageMarker(2)]);

		const { images: sent, labels } = attachments.resolve(`second ${imageMarker(2)} then ${imageMarker(1)} again ${imageMarker(2)} and ${imageMarker(9)}`);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(labels).toEqual([`${imageMarker(2)} frame.png (2×1 PNG)`, `${imageMarker(1)} Screen Shot 1.png (2×1 PNG)`]);
		expect(withImageLabels("hi", labels)).toBe(`hi\n\n[nexo] Attached images, in order: ${labels.join("; ")}.`);
		expect(withImageLabels("hi", [])).toBe("hi");
	});

	it("leaves text without image paths alone and attaches clipboard bytes", () => {
		const attachments = new ImageAttachments();
		expect(attachments.replaceDroppedPaths("just /usr/bin and words.png")).toBeNull();
		expect(attachments.attachBytes(PNG, "clipboard image")).toBe(imageMarker(1));
		expect(attachments.resolve(imageMarker(1)).labels).toEqual([`${imageMarker(1)} clipboard image (2×1 PNG)`]);
	});
});
