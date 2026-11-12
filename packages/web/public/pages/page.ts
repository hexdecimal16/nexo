import { renderError } from "../lib/common-view.ts";
import { formatTime } from "../lib/format.ts";
import { asErrorBody, el, getJson } from "./api.ts";

interface HomePage { path: string; title: string; summary?: string; updated?: string; content: string; modifiedAt: string }

const crumbs = el<HTMLParagraphElement>("#page-crumbs");
const titleEl = el<HTMLHeadingElement>("#page-title");
const meta = el<HTMLParagraphElement>("#page-meta");
const body = el<HTMLDivElement>("#page-body");
const errorBox = el<HTMLDivElement>("#error");
const DROP = "script,style,iframe,object,embed,form,link,meta,base,title";

function link(text: string, href: string): HTMLAnchorElement {
	const a = document.createElement("a");
	a.href = href;
	a.textContent = text;
	return a;
}

/** Shows the page body inline: active content removed, links to other pages kept inside page.html. */
function mount(page: HomePage): void {
	const doc = new DOMParser().parseFromString(page.content, "text/html");
	const root = doc.querySelector("main") ?? doc.body;
	root.querySelectorAll(DROP).forEach((n) => n.remove());
	root.querySelectorAll(":scope > nav, :scope > p.meta, :scope > h1").forEach((n) => n.remove());
	root.querySelectorAll("*").forEach((node) => {
		for (const attr of Array.from(node.attributes)) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on") || name === "style") node.removeAttribute(attr.name);
			else if ((name === "href" || name === "src" || name === "xlink:href") && /^\s*(javascript|data):/i.test(attr.value)) node.removeAttribute(attr.name);
		}
	});
	const base = page.path.slice(0, page.path.lastIndexOf("/") + 1);
	root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
		const href = a.getAttribute("href") ?? "";
		if (/^(https?:|mailto:)/i.test(href)) {
			a.target = "_blank";
			a.rel = "noopener noreferrer";
			return;
		}
		if (href.startsWith("#")) return;
		const target = decodeURIComponent(new URL(href, `https://home.invalid/${base}`).pathname.slice(1));
		if (target.endsWith(".html")) a.setAttribute("href", `/page.html?path=${encodeURIComponent(target)}`);
		else a.removeAttribute("href");
	});
	body.replaceChildren(...Array.from(root.childNodes).map((n) => document.importNode(n, true)));
}

const path = new URLSearchParams(location.search).get("path") ?? "";
const [area = "", folder = ""] = path.split("/");
crumbs.replaceChildren(link("Home", "/home.html"), " / ", link(area, `/area.html?id=${encodeURIComponent(area)}`), " / ", link(folder, `/page.html?path=${encodeURIComponent(`${area}/${folder}/index.html`)}`));
getJson<HomePage>(`/api/home/page?path=${encodeURIComponent(path)}`)
	.then((page) => {
		titleEl.textContent = page.title;
		document.title = `nexo · ${page.title}`;
		meta.textContent = `Updated ${page.updated || formatTime(page.modifiedAt)}`;
		mount(page);
	})
	.catch((error) => {
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	});
