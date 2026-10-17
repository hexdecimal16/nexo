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
let activePath: string = "index.md";

function showError(error: unknown): void {
	errorBox.innerHTML = renderError(asErrorBody(error)).value;
}

function parseHash(): { wiki: string | null; pagePath: string } {
	const hash = window.location.hash.replace(/^#\/?/, "");
	if (!hash) return { wiki: null, pagePath: "index.md" };
	const slash = hash.indexOf("/");
	if (slash === -1) {
		return { wiki: decodeURIComponent(hash), pagePath: "index.md" };
	}
	const wiki = decodeURIComponent(hash.slice(0, slash));
	let page = decodeURIComponent(hash.slice(slash + 1));
	if (!page.endsWith(".md")) page += ".md";
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
			} else {
				pageBox.innerHTML = '<p class="muted">No pages found in this wiki.</p>';
			}
		} catch (innerError) {
			showError(innerError);
		}
	}
}

async function loadWiki(wiki: string, pagePath = "index.md"): Promise<void> {
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

loadAll().catch(showError);
