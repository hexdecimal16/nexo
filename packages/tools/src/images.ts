import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Image types every vision API nexo talks to accepts. */
export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** File extensions treated as images when a path is dropped or pasted (the bytes still decide). */
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

/**
 * Long-edge limit images are scaled down to before they reach a model. Claude's high-resolution tier stops at 2,576 px
 * and many-image requests at 3,000 px; 2,000 px keeps text legible while staying under every provider's limit.
 */
export const MAX_IMAGE_EDGE = 2000;
/** Largest image sent as is, in raw bytes (about 4.7 MB base64): under Bedrock's 5 MB base64 per-image limit. */
export const MAX_IMAGE_BYTES = 3_500_000;
/** Images larger than this are refused outright rather than read into memory. */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export interface LoadedImage {
	image: ImageContent;
	/** Size of the image as sent. */
	width: number | null;
	height: number | null;
	/** Size of the source file, when it was scaled down. */
	original?: { width: number; height: number; bytes: number };
}

/** The image type from the file's first bytes, or null when they are not a supported image. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
	const b = bytes;
	if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
	if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
	return null;
}

function ascii(b: Uint8Array, from: number, to: number): string {
	return String.fromCharCode(...b.subarray(from, to));
}

/** Pixel size read from the image header; null when the header is not understood. */
export function imageDimensions(bytes: Uint8Array, mime: ImageMime): { width: number; height: number } | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	try {
		if (mime === "image/png") return { width: view.getUint32(16), height: view.getUint32(20) };
		if (mime === "image/gif") return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
		if (mime === "image/webp") {
			const chunk = ascii(bytes, 12, 16);
			if (chunk === "VP8X") return { width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(27, true) & 0xffffff) };
			if (chunk === "VP8L") {
				const bits = view.getUint32(21, true);
				return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
			}
			if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
			return null;
		}
		// JPEG: walk the segments to the first start-of-frame marker.
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) return null;
			const marker = bytes[offset + 1] as number;
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
			}
			offset += 2 + view.getUint16(offset + 2);
		}
		return null;
	} catch {
		return null;
	}
}

function hasCommand(command: string): boolean {
	try {
		execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Scales an image down with the platform's own tools (`sips` on macOS, ImageMagick elsewhere) so its long edge is at
 * most `maxEdge`, as JPEG when the source is not a PNG or when PNG stays too large. Null when no tool is available or
 * the tool fails; the caller then sends the original.
 */
function downscale(bytes: Uint8Array, mime: ImageMime, maxEdge: number, maxBytes: number): { bytes: Buffer; mime: ImageMime } | null {
	const dir = mkdtempSync(join(tmpdir(), "nexo-image-"));
	try {
		const src = join(dir, `in.${mime.slice(6)}`);
		writeFileSync(src, bytes);
		const attempt = (format: "png" | "jpeg"): Buffer | null => {
			const out = join(dir, `out.${format === "png" ? "png" : "jpg"}`);
			if (process.platform === "darwin" && hasCommand("sips")) {
				execFileSync("sips", ["-Z", String(maxEdge), "-s", "format", format, ...(format === "jpeg" ? ["-s", "formatOptions", "85"] : []), src, "--out", out], { stdio: "ignore", timeout: 30_000 });
			} else if (hasCommand("magick") || hasCommand("convert")) {
				const tool = hasCommand("magick") ? "magick" : "convert";
				execFileSync(tool, [`${src}[0]`, "-resize", `${maxEdge}x${maxEdge}>`, ...(format === "jpeg" ? ["-quality", "85"] : []), out], { stdio: "ignore", timeout: 30_000 });
			} else return null;
			return readFileSync(out);
		};
		// PNG keeps screenshots and text crisp; fall back to JPEG when PNG is still too large.
		const png = mime === "image/png" ? attempt("png") : null;
		if (png && png.length <= maxBytes) return { bytes: png, mime: "image/png" };
		const jpeg = attempt("jpeg");
		return jpeg ? { bytes: jpeg, mime: "image/jpeg" } : null;
	} catch {
		return null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export interface ImageLoadOptions {
	/** Long-edge limit; defaults to MAX_IMAGE_EDGE. */
	maxEdge?: number;
	/** Byte limit before scaling; defaults to MAX_IMAGE_BYTES. */
	maxBytes?: number;
}

/**
 * Prepares image bytes for a model: checks the type by content, and scales the image down when its long edge or size
 * passes the limits. Throws when the bytes are not a PNG, JPEG, GIF or WebP image.
 */
export function prepareImage(bytes: Uint8Array, options: ImageLoadOptions = {}): LoadedImage {
	const mime = sniffImageMime(bytes);
	if (!mime) throw new Error("Not a supported image (PNG, JPEG, GIF or WebP)");
	const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE;
	const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
	const size = imageDimensions(bytes, mime);
	const tooLarge = (size !== null && Math.max(size.width, size.height) > maxEdge) || bytes.length > maxBytes;
	// Animated GIFs would lose their frames; send them as they are.
	const scaled = tooLarge && mime !== "image/gif" ? downscale(bytes, mime, maxEdge, maxBytes) : null;
	if (scaled) {
		const after = imageDimensions(scaled.bytes, scaled.mime);
		return {
			image: { type: "image", data: scaled.bytes.toString("base64"), mimeType: scaled.mime },
			width: after?.width ?? null,
			height: after?.height ?? null,
			...(size ? { original: { ...size, bytes: bytes.length } } : {}),
		};
	}
	return { image: { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime }, width: size?.width ?? null, height: size?.height ?? null };
}

/** True when the file starts with image bytes. False for missing files, directories and anything else. */
export function isImageFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		const head = readFileSync(path).subarray(0, 16);
		return sniffImageMime(head) !== null;
	} catch {
		return false;
	}
}

/** Reads an image file and prepares it for a model (see prepareImage). Throws for a missing, huge or non-image file. */
export function loadImageFile(path: string, options: ImageLoadOptions = {}): LoadedImage {
	const stat = statSync(path);
	if (!stat.isFile()) throw new Error(`${path} is not a file`);
	if (stat.size > MAX_SOURCE_BYTES) throw new Error(`${basename(path)} is ${(stat.size / 1024 / 1024).toFixed(1)} MB; images over 50 MB are not read`);
	return prepareImage(readFileSync(path), options);
}

/** One-line description of a loaded image for the text next to it, e.g. `shot.png (1456×819 PNG, scaled from 3840×2160)`. */
export function describeImage(name: string, loaded: LoadedImage): string {
	const kind = loaded.image.mimeType.slice(6).toUpperCase();
	const dims = loaded.width !== null && loaded.height !== null ? `${loaded.width}×${loaded.height} ` : "";
	const scaled = loaded.original ? `, scaled from ${loaded.original.width}×${loaded.original.height}` : "";
	return `${name} (${dims}${kind}${scaled})`;
}

/**
 * The line added to a message that carries images, naming each in order (e.g. `shot.png (1456×819 PNG)`), so the model
 * can tell which image the user means. Empty labels give the text unchanged.
 */
export function withAttachedImagesNote(text: string, labels: readonly string[]): string {
	return labels.length === 0 ? text : `${text}\n\n[nexo] Attached images, in order: ${labels.join("; ")}.`;
}
