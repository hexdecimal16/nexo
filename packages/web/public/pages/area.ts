import { renderError } from "../lib/common-view.ts";
import { formatTime } from "../lib/format.ts";
import { html, type SafeHtml } from "../lib/html.ts";
import { asErrorBody, el, getJson } from "./api.ts";

interface HomeWiki { name: string; summary?: string; pageCount: number }
interface HomeArea { id: string; name: string; scope: string; wikis: HomeWiki[]; recent: number }
interface HomeFeedItem { at: string; text: string; areaId: string | null; wiki: string | null; sessionId: string | null; runId: string; verified: boolean }
interface HomeDecision { at: string; choice: string; reason: string; areaId: string | null; wiki: string | null; sessionId: string | null; runId: string }
interface HomeSession { id: string; title: string; cwd: string; updatedAt: string; areaId: string | null }
interface Home { areas: HomeArea[]; feed: HomeFeedItem[]; decisions: HomeDecision[]; sessions: HomeSession[] }

const box = el<HTMLDivElement>("#area");
const title = el<HTMLHeadingElement>("#area-title");
const errorBox = el<HTMLDivElement>("#error");

function list(items: SafeHtml[], empty: string): SafeHtml {
	return items.length > 0 ? html`<ul class="home-list">${items}</ul>` : html`<p class="muted">${empty}</p>`;
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
	const wikis = a.wikis.map((w) => html`<li><a href="/wikis.html#${encodeURIComponent(w.name)}/index">${w.name}</a> <span class="muted">${String(w.pageCount)} pages${w.summary ? ` · ${w.summary}` : ""}</span></li>`);
	const feed = d.feed.filter((f) => f.areaId === a.id).slice(0, 30).map((f) => {
		const link = f.sessionId ? html`<a href="/?session=${encodeURIComponent(f.sessionId)}">session</a>` : html`<a href="/run.html?id=${encodeURIComponent(f.runId)}">run</a>`;
		return html`<li><span class="muted mono">${formatTime(f.at)}</span> ${f.text}${f.verified ? "" : html` <span class="home-tag">unverified</span>`}${f.wiki ? html` <span class="muted">· ${f.wiki}</span>` : ""} ${link}</li>`;
	});
	const decisions = d.decisions.filter((x) => x.areaId === a.id).map((x) => html`<li><span class="muted mono">${formatTime(x.at)}</span> <strong>${x.choice}</strong>${x.reason ? html` <span class="muted">because ${x.reason}</span>` : ""}</li>`);
	const sessions = d.sessions.filter((s) => s.areaId === a.id).map((s) => html`<li><a href="/?session=${encodeURIComponent(s.id)}">${s.title || s.id}</a> <span class="muted">${s.cwd} · ${formatTime(s.updatedAt)}</span></li>`);
	box.innerHTML = html`<p class="home-note">${a.scope}</p>
<section><h2>Wikis</h2>${list(wikis, "No wikis in this area yet.")}</section>
<section><h2>Recent</h2>${list(feed, "Nothing filed here yet. Finished tasks appear here after they are scored.")}</section>
<section><h2>Decisions</h2>${list(decisions, "No decisions recorded here yet.")}</section>
<section><h2>Sessions</h2>${list(sessions, "No linked sessions yet.")}</section>`.value;
}

const id = new URLSearchParams(location.search).get("id") ?? "";
getJson<Home>("/api/home")
	.then((d) => render(d, id))
	.catch((error) => {
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	});
