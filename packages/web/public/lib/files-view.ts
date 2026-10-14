import type { DirListing } from "./api-types.ts";
import { html, type SafeHtml } from "./html.ts";

export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
}

export function isDiffPath(path: string): boolean {
	return /\.(diff|patch)$/.test(path);
}

/** API path of a file or directory inside a run directory, each segment percent-encoded. */
export function filePath(runId: string, path: string, full = false): string {
	const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
	return `/api/runs/${encodeURIComponent(runId)}/files/${encoded}${full ? "?full=1" : ""}`;
}

export function parseUnifiedDiff(text: string): DiffLine[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.map((line): DiffLine => {
		if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("Index:") || line.startsWith("====")) return { kind: "meta", text: line };
		if (line.startsWith("@@")) return { kind: "hunk", text: line };
		if (line.startsWith("+")) return { kind: "add", text: line };
		if (line.startsWith("-")) return { kind: "del", text: line };
		return { kind: "ctx", text: line };
	});
}

export function renderDiff(lines: DiffLine[]): SafeHtml {
	return html`<pre class="diff">${lines.map((l) => html`<span class="diff-${l.kind}">${l.text}</span>`)}</pre>`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderListing(listing: DirListing): SafeHtml {
	const segments = listing.path ? listing.path.split("/") : [];
	const crumbs = [html`<button type="button" class="link" data-dir="">run</button>`];
	segments.forEach((name, i) => crumbs.push(html` / <button type="button" class="link" data-dir="${segments.slice(0, i + 1).join("/")}">${name}</button>`));
	return html`<nav class="crumbs">${crumbs}</nav>
<ul class="files">${listing.entries.length === 0 ? html`<li class="muted">empty</li>` : ""}${listing.entries.map((e) => {
		if (e.kind === "dir") return html`<li><button type="button" class="link dir" data-dir="${e.path}">${e.name}/</button></li>`;
		if (e.kind === "symlink") return html`<li><button type="button" class="link file" data-file="${e.path}">${e.name}</button> <span class="muted">symlink</span></li>`;
		if (e.kind === "other") return html`<li><span class="muted">${e.name} (not a regular file)</span></li>`;
		return html`<li><button type="button" class="link file" data-file="${e.path}">${e.name}</button> <span class="muted">${formatSize(e.size)}</span></li>`;
	})}</ul>`;
}

export type MediaKind = "video" | "audio" | "image";

/** Extensions the files API serves under a media type (kept in step with `MEDIA_TYPES` in the server's api.ts). */
const MEDIA_KINDS: Record<string, MediaKind> = {
	mp4: "video", m4v: "video", webm: "video", mov: "video",
	mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio",
	png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
};

export function mediaKind(path: string): MediaKind | null {
	const dot = path.lastIndexOf(".");
	if (dot < 0 || dot < path.lastIndexOf("/")) return null;
	return MEDIA_KINDS[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** A player or image for a media file, loaded straight from the files API, with a link to open it on its own. */
export function renderMedia(path: string, kind: MediaKind, src: string): SafeHtml {
	const player =
		kind === "video" ? html`<video class="media" controls preload="metadata" src="${src}"></video>`
		: kind === "audio" ? html`<audio class="media" controls preload="metadata" src="${src}"></audio>`
		: html`<img class="media" alt="${path}" src="${src}">`;
	return html`<div class="file-view">
	<div class="file-head mono">${path} · <a href="${src}" target="_blank" rel="noopener noreferrer">open</a></div>
	${player}
</div>`;
}

/** File contents: unified diffs get line colouring, anything else is plain preformatted text. */
export function renderFile(path: string, text: string, truncatedSize: number | null): SafeHtml {
	return html`<div class="file-view">
	<div class="file-head mono">${path}</div>
	${truncatedSize !== null ? html`<p class="note">Showing the first 1 MB of ${formatSize(truncatedSize)}. <button type="button" class="link" data-file-full="${path}">Load everything</button></p>` : ""}
	${isDiffPath(path) ? renderDiff(parseUnifiedDiff(text)) : html`<pre>${text}</pre>`}
</div>`;
}
