import { existsSync } from "node:fs";
import { join } from "node:path";

/** Wiki pages are HTML (preferred) or markdown (legacy, still read during the migration). */
const WIKI_PAGE_EXT = /\.(md|html)$/;

export function isWikiPageFile(name: string): boolean {
	return WIKI_PAGE_EXT.test(name);
}

/** The page path without its .md or .html extension. */
export function wikiPageSlug(relPath: string): string {
	return relPath.replace(WIKI_PAGE_EXT, "");
}

/** Maps an extensionless page path (concepts/raft) to the .html file when it exists, else the .md one. Paths with an extension are returned unchanged. */
export function resolveWikiPagePath(wikiDir: string, relPath: string): string {
	if (WIKI_PAGE_EXT.test(relPath)) return relPath;
	const html = `${relPath}.html`;
	return existsSync(join(wikiDir, html)) ? html : `${relPath}.md`;
}

const ESCAPES: Record<string, string> = {
	"\u0026": "\u0026amp;",
	"<": "\u0026lt;",
	">": "\u0026gt;",
	'"': "\u0026quot;",
	"'": "\u0026#39;",
};

export function escapeHtml(text: string): string {
	return text.replace(/[\u0026<>"']/g, (c) => ESCAPES[c] ?? c);
}

const UNESCAPES: Record<string, string> = Object.fromEntries(Object.entries(ESCAPES).map(([k, v]) => [v, k]));

function unescapeHtml(text: string): string {
	return text.replace(/\u0026(amp|lt|gt|quot|#39);/g, (m) => UNESCAPES[m] ?? m);
}

export interface WikiMeta {
	summary?: string;
	updated?: string;
	sources?: string;
}

/** Reads summary, updated and sources from meta tags in the head of an HTML wiki page. Returns an empty object for non-HTML content. */
export function parseWikiMeta(content: string): WikiMeta {
	const head = content.slice(0, 4096);
	if (!/^\s*<(!doctype|html)/i.test(head)) return {};
	const meta: Record<string, string> = {};
	for (const m of head.matchAll(/<meta\s+name=["']([a-z]+)["']\s+content=["']([^"']*)["']/gi)) {
		if (m[1] && m[2] !== undefined) meta[m[1].toLowerCase()] = unescapeHtml(m[2]);
	}
	return { summary: meta.summary || undefined, updated: meta.updated || undefined, sources: meta.sources || undefined };
}

const PAGE_STYLE =
	":root{--bg:#fafaf7;--fg:#1c1c1a;--muted:#6b6b66;--line:#e2e1da;--accent:#1f5fbf;--card:#fff}" +
	"body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}" +
	"main{max-width:760px;margin:0 auto;padding:32px 20px 80px}h1{font-size:28px;line-height:1.25}" +
	"h2{font-size:20px;margin-top:36px;border-top:1px solid var(--line);padding-top:20px}a{color:var(--accent)}" +
	".meta{color:var(--muted);font-size:14px}table{border-collapse:collapse;width:100%;background:var(--card)}" +
	"th,td{border:1px solid var(--line);padding:8px 10px;text-align:left}code{background:#efeee8;padding:1px 5px;border-radius:3px}" +
	"pre{background:#efeee8;padding:12px;border-radius:6px;overflow:auto}svg{max-width:100%;height:auto}@media print{body{background:#fff}}";

export interface WikiHtmlInput {
	title: string;
	summary: string;
	updated: string;
	sources: readonly string[];
	/** Body fragment: no html, head or script elements. Script elements are stripped. */
	body: string;
}

/** Wraps a body fragment into a complete, self-contained wiki page with summary, updated and sources in meta tags. */
export function wrapWikiHtml(input: WikiHtmlInput): string {
	const body = input.body.replace(/<script[\s\S]*?<\/script>/gi, "").trim();
	const summary = escapeHtml(input.summary.replace(/\s+/g, " ").trim());
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<meta name="summary" content="${summary}">`,
		`<meta name="updated" content="${escapeHtml(input.updated)}">`,
		`<meta name="sources" content="${escapeHtml(input.sources.join("; "))}">`,
		`<title>${escapeHtml(input.title)}</title>`,
		`<style>${PAGE_STYLE}</style>`,
		"</head>",
		"<body>",
		"<main>",
		`<h1>${escapeHtml(input.title)}</h1>`,
		`<p class="meta">Updated ${escapeHtml(input.updated)}</p>`,
		body,
		"</main>",
		"</body>",
		"</html>",
		"",
	].join("\n");
}
