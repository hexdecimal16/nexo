import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import { describeImage, IMAGE_EXTENSIONS, withAttachedImagesNote, isImageFile, type LoadedImage, loadImageFile, prepareImage } from "@nexo/tools";

/** A path dropped or pasted into the editor: where it sits in the text and the file it names. */
export interface DroppedPath {
	start: number;
	end: number;
	path: string;
}

/**
 * A path token starting at a word boundary: single- or double-quoted, or unquoted with backslash-escaped spaces, the
 * forms terminals use when a file is dragged in (iTerm and Terminal escape, Ghostty and VS Code quote).
 */
const PATH_TOKEN = /(^|\s)('[^'\n]+'|"[^"\n]+"|(?:\\.|[^\s\\'"])+)/g;

function unquote(token: string): string {
	if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) return token.slice(1, -1);
	return token.replace(/\\(.)/g, "$1");
}

/** The absolute file path a token names, or null: only absolute, `~/` and `file://` paths count, so typed words never do. */
function tokenPath(token: string): string | null {
	const raw = unquote(token);
	let path: string;
	if (raw.startsWith("file://")) {
		try {
			path = fileURLToPath(raw);
		} catch {
			return null;
		}
	} else if (raw.startsWith("~/")) path = `${homedir()}${raw.slice(1)}`;
	else if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) path = raw;
	else return null;
	return (IMAGE_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase()) ? path : null;
}

/** Image files named by dropped or pasted paths in `text`, in order. Paths to missing or non-image files are left out. */
export function findDroppedImagePaths(text: string, isImage: (path: string) => boolean = isImageFile): DroppedPath[] {
	const out: DroppedPath[] = [];
	for (const match of text.matchAll(PATH_TOKEN)) {
		const token = match[2] as string;
		const path = tokenPath(token);
		if (!path || !isImage(path)) continue;
		const start = (match.index ?? 0) + (match[1] as string).length;
		out.push({ start, end: start + token.length, path });
	}
	return out;
}

const MARKER = /\[Image #(\d+)\]/g;

export const imageMarker = (n: number): string => `[Image #${n}]`;

interface Attachment {
	image: ImageContent;
	label: string;
}

/**
 * Images attached to the draft. Each one gets a `[Image #n]` marker in the editor; a submitted message carries the
 * images whose markers it still contains, in the order they appear, so deleting a marker drops its image. Attachments
 * live as long as the TUI, so a message recalled from history or put back from the queue keeps its images.
 */
export class ImageAttachments {
	private readonly byId = new Map<number, Attachment>();
	private next = 1;

	private add(loaded: LoadedImage, name: string): string {
		const id = this.next++;
		this.byId.set(id, { image: loaded.image, label: describeImage(name, loaded) });
		return imageMarker(id);
	}

	/** Attaches an image file and returns its marker. Throws for an unreadable or non-image file. */
	attachFile(path: string): string {
		return this.add(loadImageFile(path), basename(path));
	}

	/** Attaches image bytes (a clipboard image) and returns its marker. */
	attachBytes(bytes: Uint8Array, name: string): string {
		return this.add(prepareImage(bytes), name);
	}

	/**
	 * Replaces every dropped image path in `text` with its marker. Returns null when there is none, so the editor is
	 * left alone; `failed` lists paths that looked like images but could not be read.
	 */
	replaceDroppedPaths(text: string): { text: string; attached: string[]; failed: string[] } | null {
		const dropped = findDroppedImagePaths(text);
		if (dropped.length === 0) return null;
		let out = "";
		let at = 0;
		const attached: string[] = [];
		const failed: string[] = [];
		for (const d of dropped) {
			out += text.slice(at, d.start);
			try {
				const marker = this.attachFile(d.path);
				out += marker;
				attached.push(marker);
			} catch {
				out += text.slice(d.start, d.end);
				failed.push(d.path);
			}
			at = d.end;
		}
		out += text.slice(at);
		return attached.length > 0 || failed.length > 0 ? { text: out, attached, failed } : null;
	}

	/** The images a message's markers refer to, in order (a repeated marker counts once), with a line naming each. */
	resolve(text: string): { images: ImageContent[]; labels: string[] } {
		const images: ImageContent[] = [];
		const labels: string[] = [];
		const seen = new Set<number>();
		for (const match of text.matchAll(MARKER)) {
			const id = Number(match[1]);
			const attachment = this.byId.get(id);
			if (!attachment || seen.has(id)) continue;
			seen.add(id);
			images.push(attachment.image);
			labels.push(`${imageMarker(id)} ${attachment.label}`);
		}
		return { images, labels };
	}
}

/** The message sent for a draft with images: the text as typed, plus a line saying which image each marker is. */
export const withImageLabels = withAttachedImagesNote;

/**
 * The image on the system clipboard as PNG bytes, or null when there is none or no clipboard tool is available:
 * AppleScript on macOS, wl-paste or xclip on Linux.
 */
export function readClipboardImage(): Buffer | null {
	const run = (command: string, args: string[]): Buffer | null => {
		try {
			const out = execFileSync(command, args, { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 200 * 1024 * 1024, timeout: 10_000 });
			return out.length > 0 ? out : null;
		} catch {
			return null;
		}
	};
	if (process.platform === "darwin") {
		const out = run("osascript", ["-e", "try", "-e", "the clipboard as «class PNGf»", "-e", "end try"]);
		const hex = out?.toString("utf8").match(/«data PNGf([0-9A-Fa-f]+)»/)?.[1];
		return hex ? Buffer.from(hex, "hex") : null;
	}
	if (process.platform === "linux") {
		return run("wl-paste", ["--no-newline", "--type", "image/png"]) ?? run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
	}
	return null;
}
