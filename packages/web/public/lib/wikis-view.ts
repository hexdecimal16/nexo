import type { WikiItem, WikiPageItem, WikiPageResponse } from "./api-types.ts";
import { formatTime } from "./format.ts";
import { esc, html, SafeHtml } from "./html.ts";

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Renders inline markdown: bold, italic, code, links, and wikilinks. Input must already have special characters escaped or handled. */
function renderInline(text: string, activeWiki: string): string {
	const codeTokens: string[] = [];
	let s = text.replace(/`([^`]+)`/g, (_m, code: string) => {
		const idx = codeTokens.length;
		codeTokens.push(`<code>${esc(code)}</code>`);
		return `\x00CODE_${idx}\x00`;
	});

	s = esc(s);

	// Wikilinks: [[target|label]] or [[target]]
	s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, rawTarget: string, rawLabel?: string) => {
		const target = rawTarget.trim().replace(/\.md$/, "");
		const label = (rawLabel ?? rawTarget).trim();
		const href = `#${encodeURIComponent(activeWiki)}/${target.split("/").map(encodeURIComponent).join("/")}`;
		return `<a href="${href}" class="wikilink" data-wiki-nav="${esc(target)}">${esc(label)}</a>`;
	});

	// Standard links: [text](url) - only allow http, https, or in-page hash links
	s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
		const cleanUrl = url.trim();
		if (/^(https?:|\/|#)/i.test(cleanUrl)) {
			return `<a href="${esc(cleanUrl)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
		}
		return esc(label);
	});

	// Bold: **text**
	s = s.replace(/\*\*([^*]+)\*\*/g, (_match, content: string) => `<strong>${content}</strong>`);

	// Italic: *text*
	s = s.replace(/(^|[^\*])\*([^*]+)\*/g, (_match, prefix: string, content: string) => `${prefix}<em>${content}</em>`);

	// Restore code tokens
	s = s.replace(/\x00CODE_(\d+)\x00/g, (_m, idxStr: string) => {
		const idx = Number(idxStr);
		return codeTokens[idx] ?? "";
	});

	return s;
}

/** Parses markdown text and returns sanitized SafeHtml, supporting frontmatter summaries and [[wikilinks]]. */
export function renderMarkdown(content: string, activeWiki: string): SafeHtml {
	let body = content;

	// Strip frontmatter if present
	if (body.startsWith("---")) {
		const end = body.indexOf("\n---", 3);
		if (end !== -1) {
			body = body.slice(end + 4).trimStart();
		}
	}

	const lines = body.split("\n");
	const out: string[] = [];
	let inCodeBlock = false;
	let codeLang = "";
	let codeLines: string[] = [];
	let inList: "ul" | "ol" | null = null;
	let inBlockquote = false;
	let quoteLines: string[] = [];

	const flushList = () => {
		if (inList) {
			out.push(`</${inList}>`);
			inList = null;
		}
	};

	const flushQuote = () => {
		if (inBlockquote) {
			out.push(`<blockquote><p>${quoteLines.map((l) => renderInline(l, activeWiki)).join("<br>")}</p></blockquote>`);
			inBlockquote = false;
			quoteLines = [];
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		// Code block delimiter
		if (line.startsWith("```")) {
			if (inCodeBlock) {
				out.push(`<pre class="code-block"><code>${esc(codeLines.join("\n"))}</code></pre>`);
				inCodeBlock = false;
				codeLines = [];
			} else {
				flushList();
				flushQuote();
				inCodeBlock = true;
				codeLang = line.slice(3).trim();
				codeLines = [];
			}
			continue;
		}

		if (inCodeBlock) {
			codeLines.push(line);
			continue;
		}

		// Empty line
		if (!line.trim()) {
			flushList();
			flushQuote();
			continue;
		}

		// Headings (# Heading)
		const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
		if (headingMatch) {
			flushList();
			flushQuote();
			const level = (headingMatch[1] ?? "#").length;
			const text = headingMatch[2] ?? "";
			out.push(`<h${level}>${renderInline(text, activeWiki)}</h${level}>`);
			continue;
		}

		// Blockquotes (> Quote)
		if (line.startsWith(">")) {
			flushList();
			inBlockquote = true;
			quoteLines.push(line.replace(/^>\s?/, ""));
			continue;
		} else if (inBlockquote) {
			flushQuote();
		}

		// Unordered list (- Item or * Item)
		const ulMatch = /^[-*]\s+(.+)$/.exec(line);
		if (ulMatch) {
			flushQuote();
			if (inList !== "ul") {
				flushList();
				out.push("<ul>");
				inList = "ul";
			}
			out.push(`<li>${renderInline(ulMatch[1] ?? "", activeWiki)}</li>`);
			continue;
		}

		// Ordered list (1. Item)
		const olMatch = /^\d+\.\s+(.+)$/.exec(line);
		if (olMatch) {
			flushQuote();
			if (inList !== "ol") {
				flushList();
				out.push("<ol>");
				inList = "ol";
			}
			out.push(`<li>${renderInline(olMatch[1] ?? "", activeWiki)}</li>`);
			continue;
		}

		// Regular paragraph
		flushList();
		flushQuote();
		out.push(`<p>${renderInline(line, activeWiki)}</p>`);
	}

	if (inCodeBlock) {
		out.push(`<pre class="code-block"><code>${esc(codeLines.join("\n"))}</code></pre>`);
	}
	flushList();
	flushQuote();

	return new SafeHtml(out.join("\n"));
}

/** Renders the wiki selector dropdown and summary facts. */
export function renderWikiSelector(wikis: readonly WikiItem[], activeWiki: string | null): SafeHtml {
	if (wikis.length === 0) {
		return html`<p class="muted">No wikis created yet. Ask nexo to create one with the <code>wiki</code> skill.</p>`;
	}
	return html`<div class="wiki-selector">
	<label>Wiki <select id="wiki-select">
		${wikis.map((w) => html`<option value="${w.name}" ${w.name === activeWiki ? "selected" : ""}>${w.name} (${w.pageCount} pages)</option>`)}
	</select></label>
</div>`;
}

/** Groups wiki pages by directory/folder and renders a navigable tree sidebar. */
export function renderWikiTree(pages: readonly WikiPageItem[], activeWiki: string, activePath: string): SafeHtml {
	if (pages.length === 0) {
		return html`<p class="muted">Wiki is empty.</p>`;
	}

	// Group into root files and folder files
	const rootPages: WikiPageItem[] = [];
	const folders = new Map<string, WikiPageItem[]>();

	for (const p of pages) {
		if (p.folder) {
			const list = folders.get(p.folder) ?? [];
			list.push(p);
			folders.set(p.folder, list);
		} else {
			rootPages.push(p);
		}
	}

	return html`<nav class="wiki-tree">
	<div class="wiki-tree-section">
		<div class="wiki-tree-title">Pages</div>
		<ul class="wiki-tree-list">
			${rootPages.map((p) => html`<li class="wiki-tree-item ${p.path === activePath ? "active" : ""}">
				<a href="#${encodeURIComponent(activeWiki)}/${encodeURIComponent(p.slug)}" data-page-path="${p.path}">${p.slug}</a>
				${p.summary ? html`<span class="wiki-item-summary muted">${p.summary}</span>` : ""}
			</li>`)}
		</ul>
	</div>
	${[...folders.entries()].map(([folder, folderPages]) => html`<div class="wiki-tree-section">
		<div class="wiki-tree-folder">${folder}/</div>
		<ul class="wiki-tree-list">
			${folderPages.map((p) => {
				const itemSlug = p.slug.startsWith(folder + "/") ? p.slug.slice(folder.length + 1) : p.slug;
				return html`<li class="wiki-tree-item ${p.path === activePath ? "active" : ""}">
					<a href="#${encodeURIComponent(activeWiki)}/${encodeURIComponent(p.slug)}" data-page-path="${p.path}">${itemSlug}</a>
					${p.summary ? html`<span class="wiki-item-summary muted">${p.summary}</span>` : ""}
				</li>`;
			})}
		</ul>
	</div>`)}
</nav>`;
}

/** Renders a full wiki page view with breadcrumbs, summary box, rendered content and metadata. */
export function renderWikiPage(page: WikiPageResponse, activeWiki: string): SafeHtml {
	const renderedContent = renderMarkdown(page.content, activeWiki);
	return html`<article class="wiki-page">
	<header class="wiki-page-header">
		<div class="wiki-crumbs mono">
			<a href="#${encodeURIComponent(activeWiki)}/index">${activeWiki}</a> / <span>${page.path}</span>
		</div>
		<div class="wiki-meta muted mono">
			${formatSize(page.size)} · updated ${formatTime(page.modifiedAt)}
		</div>
	</header>
	${page.summary ? html`<div class="wiki-summary-box"><div class="wiki-summary-label">summary</div><p>${page.summary}</p></div>` : ""}
	<div class="wiki-prose">
		${renderedContent}
	</div>
</article>`;
}
