import { renderError } from "../lib/common-view.ts";
import { formatTime } from "../lib/format.ts";
import { html, type SafeHtml } from "../lib/html.ts";
import { asErrorBody, el, getJson } from "./api.ts";

interface HomeWiki { name: string; summary?: string; pageCount: number; path: string }
interface HomeArea { id: string; name: string; scope: string; wikis: HomeWiki[]; recent: number }
interface HomeFeedItem { at: string; text: string; areaId: string | null; wiki: string | null; sessionId: string | null; runId: string; verified: boolean; pages?: string[] }
interface HomeDecision { at: string; choice: string; reason: string; areaId: string | null; wiki: string | null; sessionId: string | null; runId: string }
interface HomeSession { id: string; title: string; cwd: string; updatedAt: string; areaId: string | null }
interface Home { areas: HomeArea[]; feed: HomeFeedItem[]; decisions: HomeDecision[]; sessions: HomeSession[] }

const box = el<HTMLDivElement>("#area");
const title = el<HTMLHeadingElement>("#area-title");
const errorBox = el<HTMLDivElement>("#error");

const empty = (text: string): SafeHtml => html`<p class="muted">${text}</p>`;
const stat = (n: number, label: string): SafeHtml => html`<div class="area-stat"><b>${String(n)}</b><span class="muted">${label}</span></div>`;

function pageLinks(f: { pages?: string[]; wiki: string | null; areaId: string | null }): SafeHtml {
	const pages = (f.pages ?? []).filter((p) => p.endsWith(".html") && p.includes("/") && !p.includes(".."));
	if (pages.length > 0) return html`${pages.map((p) => html`<a class="feed-page" href="/page.html?path=${encodeURIComponent(p)}">${p.slice(p.lastIndexOf("/") + 1, -5)}</a> `)}`;
	return f.wiki && f.areaId ? html`<a class="feed-page" href="/page.html?path=${encodeURIComponent(`${f.areaId}/${f.wiki}/index.html`)}">${f.wiki}</a>` : html``;
}

function render(d: Home, id: string): void {
	const a = d.areas.find((x) => x.id === id);
	if (!a) {
		title.textContent = "Area not found";
		box.innerHTML = html`<p class="muted">No active area "${id}". <a href="/home.html">Back to Home</a>.</p>`.value;
		return;
	}
	title.textContent = a.name;
	document.title = `nexo · ${a.name}`;
	const feed = d.feed.filter((f) => f.areaId === a.id).slice(0, 30);
	const decisions = d.decisions.filter((x) => x.areaId === a.id);
	const sessions = d.sessions.filter((s) => s.areaId === a.id);
	const pages = a.wikis.reduce((n, w) => n + w.pageCount, 0);
	const wikis = a.wikis.map((w) => html`<a class="area-card" href="/page.html?path=${encodeURIComponent(`${w.path}/index.html`)}"><strong>${w.name}</strong><span class="muted">${String(w.pageCount)} pages</span>${w.summary ? html`<span class="area-card-text">${w.summary}</span>` : ""}</a>`);
	const timeline = feed.map((f) => {
		const link = f.sessionId ? html`<a href="/?session=${encodeURIComponent(f.sessionId)}">session</a>` : html`<a href="/run.html?id=${encodeURIComponent(f.runId)}">run</a>`;
		return html`<li><time>${formatTime(f.at)}${f.wiki ? ` · ${f.wiki}` : ""}</time>${f.text}${f.verified ? "" : html` <span class="home-tag">unverified</span>`} ${pageLinks(f)} ${link}</li>`;
	});
	const decisionCards = decisions.map((x) => html`<div class="area-decision"><strong>${x.choice}</strong>${x.reason ? html`<span class="muted">Because ${x.reason}</span>` : ""}<time class="muted">${formatTime(x.at)}</time></div>`);
	const rows = sessions.map((s) => html`<tr><td><a href="/?session=${encodeURIComponent(s.id)}">${s.title || s.id}</a></td><td class="mono muted">${s.cwd}</td><td class="muted">${formatTime(s.updatedAt)}</td></tr>`);
	box.innerHTML = html`<p class="home-note">${a.scope}</p>
<div class="area-stats">${stat(a.wikis.length, "wikis")}${stat(pages, "pages")}${stat(a.recent, "filed this week")}${stat(decisions.length, "decisions")}</div>
<section><h2>Wikis</h2>${wikis.length > 0 ? html`<div class="area-grid">${wikis}</div>` : empty("No wikis in this area yet.")}</section>
<section><h2>Recent</h2>${timeline.length > 0 ? html`<ol class="area-timeline">${timeline}</ol>` : empty("Nothing filed here yet. Finished tasks appear here after they are scored.")}</section>
<section><h2>Decisions</h2>${decisionCards.length > 0 ? decisionCards : empty("No decisions recorded here yet.")}</section>
<section><h2>Sessions</h2>${rows.length > 0 ? html`<table class="area-table"><thead><tr><th>Session</th><th>Folder</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>` : empty("No linked sessions yet.")}</section>`.value;
}

const id = new URLSearchParams(location.search).get("id") ?? "";
getJson<Home>("/api/home")
	.then((d) => render(d, id))
	.catch((error) => {
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	});
