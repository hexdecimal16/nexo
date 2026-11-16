import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuiltinTools, FileLeases, imageDimensions, isImageFile, prepareImage, sniffImageMime } from "../src/index.ts";

/** A 2×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEUlEQVR4nGP4z8DAwMDAAAAZ8AL+8V3m9wAAAABJRU5ErkJggg==", "base64");
/** Header bytes of a 640×480 baseline JPEG (SOI, APP0, SOF0). */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00]);
const GIF = Buffer.from("R0lGODlhAwAFAIAAAP///wAAACwAAAAAAwAFAAACAoRRADs=", "base64");

describe("image helpers", () => {
	it("recognises images by their bytes and reads their size", () => {
		expect(sniffImageMime(PNG)).toBe("image/png");
		expect(imageDimensions(PNG, "image/png")).toEqual({ width: 2, height: 1 });
		expect(sniffImageMime(JPEG)).toBe("image/jpeg");
		expect(imageDimensions(JPEG, "image/jpeg")).toEqual({ width: 640, height: 480 });
		expect(sniffImageMime(GIF)).toBe("image/gif");
		expect(imageDimensions(GIF, "image/gif")).toEqual({ width: 3, height: 5 });
		expect(sniffImageMime(Buffer.from("hello world, not an image"))).toBeNull();
	});

	it("prepares a small image as is and refuses non-images", () => {
		const loaded = prepareImage(PNG);
		expect(loaded).toMatchObject({ width: 2, height: 1, image: { type: "image", mimeType: "image/png", data: PNG.toString("base64") } });
		expect(loaded.original).toBeUndefined();
		expect(() => prepareImage(Buffer.from("text"))).toThrow(/Not a supported image/);
	});

	it("goes by content, not extension", () => {
		const dir = mkdtempSync(join(tmpdir(), "nexo-img-"));
		writeFileSync(join(dir, "shot.dat"), PNG);
		writeFileSync(join(dir, "fake.png"), "not really");
		expect(isImageFile(join(dir, "shot.dat"))).toBe(true);
		expect(isImageFile(join(dir, "fake.png"))).toBe(false);
		expect(isImageFile(join(dir, "missing.png"))).toBe(false);
	});
});

describe("read tool images", () => {
	const setup = () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-ws-"));
		writeFileSync(join(ws, "shot.png"), PNG);
		writeFileSync(join(ws, "a.txt"), "hello");
		const read = createBuiltinTools({ workspaceRoot: ws, holder: "run-1", leases: new FileLeases(), bashTimeoutMs: 5000 }).find((t) => t.name === "read")!;
		return { read };
	};

	it("returns an image file as a description and the image", async () => {
		const { read } = setup();
		const result = await read.execute("1", { path: "shot.png" });
		expect(result.content).toEqual([
			{ type: "text", text: "Image shot.png (2×1 PNG):" },
			{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
		]);
	});

	it("mixes text files and images in a batched read", async () => {
		const { read } = setup();
		const result = await read.execute("1", { paths: [{ path: "a.txt" }, { path: "shot.png" }] });
		expect(result.content.map((c) => c.type)).toEqual(["text", "image"]);
		expect(result.content[0]).toEqual({ type: "text", text: "==> a.txt <==\nhello\n\n==> shot.png <==\nImage shot.png (2×1 PNG):" });
	});
});
