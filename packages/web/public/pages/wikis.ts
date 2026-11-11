import type { WikiListResponse, WikiPageResponse, WikiPagesResponse } from "../lib/api-types.ts";
import { renderError } from "../lib/common-view.ts";
import { renderWikiPage, renderWikiSelector, renderWikiTree } from "../lib/wikis-view.ts";
import { asErrorBody, el, getJson } from "./api.ts";

const errorBox = el<HTMLDivElement>("#error");
const selectorBox = el<HTMLDivElement>("#wiki-selector-container");
const treeBox = el<HTMLDivElement>("#wiki-tree-container");
const pageBox = el<HTMLDivElement>("#wiki-page-container");

let currentWikis: string[] = [];
let activeWiki: string | null = null;
let activePath: string = "index";

function showError(error: unknown): void {
	errorBox.innerHTML = renderError(asErrorBody(error)).value;
}

function parseHash(): { wiki: string | null; pagePath: string } {
	const hash = window.location.hash.replace(/^#\/?/, "");
	if (!hash) return { wiki: null, pagePath: "index" };
	const slash = hash.indexOf("/");
	if (slash === -1) {
		return { wiki: decodeURIComponent(hash), pagePath: "index" };
	}
	const wiki = decodeURIComponent(hash.slice(0, slash));
	const page = decodeURIComponent(hash.slice(slash + 1));
	return { wiki, pagePath: page };
}

async function loadPage(wiki: string, path: string): Promise<void> {
	activeWiki = wiki;
	activePath = path;
	errorBox.innerHTML = "";

	try {
		const [pagesData, pageData] = await Promise.all([
			getJson<WikiPagesResponse>(`/api/wikis/${encodeURIComponent(wiki)}/pages`),
			getJson<WikiPageResponse>(`/api/wikis/${encodeURIComponent(wiki)}/page?path=${encodeURIComponent(path)}`),
		]);
		treeBox.innerHTML = renderWikiTree(pagesData.pages, wiki, path).value;
		pageBox.innerHTML = renderWikiPage(pageData, wiki).value;
		mountHtmlPage(pageData, wiki);
	} catch (error) {
		// If index.md doesn't exist, try loading the first available page
		try {
			const pagesData = await getJson<WikiPagesResponse>(`/api/wikis/${encodeURIComponent(wiki)}/pages`);
			treeBox.innerHTML = renderWikiTree(pagesData.pages, wiki, path).value;
			if (pagesData.pages.length > 0 && pagesData.pages[0]) {
				const firstPage = pagesData.pages[0];
				activePath = firstPage.path;
				const pageData = await getJson<WikiPageResponse>(`/api/wikis/${encodeURIComponent(wiki)}/page?path=${encodeURIComponent(firstPage.path)}`);
				pageBox.innerHTML = renderWikiPage(pageData, wiki).value;
		mountHtmlPage(pageData, wiki);
			} else {
				pageBox.innerHTML = '<p class="muted">No pages found in this wiki.</p>';
			}
		} catch (innerError) {
			showError(innerError);
		}
	}
}

async function loadWiki(wiki: string, pagePath = "index"): Promise<void> {
	activeWiki = wiki;
	await loadPage(wiki, pagePath);
}

async function loadAll(): Promise<void> {
	errorBox.innerHTML = "";
	const list = await getJson<WikiListResponse>("/api/wikis");
	currentWikis = list.wikis.map((w) => w.name);

	const parsed = parseHash();
	const targetWiki = (parsed.wiki && currentWikis.includes(parsed.wiki)) ? parsed.wiki : (currentWikis[0] ?? null);

	selectorBox.innerHTML = renderWikiSelector(list.wikis, targetWiki).value;

	if (targetWiki) {
		await loadWiki(targetWiki, parsed.pagePath);
	} else {
		treeBox.innerHTML = "";
		pageBox.innerHTML = '<p class="muted">No wikis available.</p>';
	}
}

window.addEventListener("hashchange", () => {
	const parsed = parseHash();
	if (parsed.wiki && currentWikis.includes(parsed.wiki)) {
		if (parsed.wiki !== activeWiki || parsed.pagePath !== activePath) {
			loadPage(parsed.wiki, parsed.pagePath).catch(showError);
		}
	}
});

selectorBox.addEventListener("change", (event) => {
	const select = event.target as HTMLSelectElement;
	if (select && select.id === "wiki-select") {
		const newWiki = select.value;
		window.location.hash = `#${encodeURIComponent(newWiki)}/index`;
	}
});

const DROP_TAGS = "script,style,iframe,object,embed,form,link,meta,base";

/** Renders an HTML wiki page inline: keeps the page body, removes active content, and rewrites relative links to viewer hashes. */
function mountHtmlPage(page: WikiPageResponse, wiki: string): void {
	if (!page.path.endsWith(".html")) return;
	const host = pageBox.querySelector<HTMLDivElement>("#wiki-html-body");
	if (!host) return;
	const doc = new DOMParser().parseFromString(page.content, "text/html");
	const root = doc.querySelector("main") ?? doc.body;
	root.querySelectorAll(DROP_TAGS).forEach((n) => n.remove());
	root.querySelectorAll(":scope > nav, :scope > p.meta").forEach((n) => n.remove());
	root.querySelectorAll("*").forEach((el) => {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on") || name === "style") el.removeAttribute(attr.name);
			else if ((name === "href" || name === "src" || name === "xlink:href") && /^\s*(javascript|data):/i.test(attr.value)) el.removeAttribute(attr.name);
		}
	});
	const base = page.path.includes("/") ? page.path.slice(0, page.path.lastIndexOf("/") + 1) : "";
	root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
		const href = a.getAttribute("href") ?? "";
		if (/^(https?:|mailto:)/i.test(href)) {
			a.target = "_blank";
			a.rel = "noopener noreferrer";
			return;
		}
		if (href.startsWith("#")) return;
		const url = new URL(href, `https://wiki.invalid/${encodeURIComponent(wiki)}/${base}`);
		const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		const targetWiki = parts.shift() ?? wiki;
		const slug = parts.join("/").replace(/\.(html|md)$/, "");
		a.setAttribute("href", `#${encodeURIComponent(targetWiki)}/${slug.split("/").map(encodeURIComponent).join("/")}`);
	});
	host.replaceChildren(...Array.from(root.childNodes).map((n) => document.importNode(n, true)));
}

loadAll().catch(showError);
