import { renderError } from "../lib/common-view.ts";
import { formatTime } from "../lib/format.ts";
import { html, type SafeHtml } from "../lib/html.ts";
import { asErrorBody, el, getJson } from "./api.ts";

interface HomeWiki { name: string; summary?: string; pageCount: number }
interface HomeArea { id: string; name: string; scope: string; wikis: HomeWiki[]; recent: number }
interface HomeFeedItem { at: string; text: string; areaId: string | null; wiki: string | null; sessionId: string | null; runId: string; verified: boolean }
interface HomeDecision { at: string; choice: string; reason: string; areaId: string | null; wiki: string | null; sessionId: string | null; runId: string }
interface HomeSession { id: string; title: string; cwd: string; updatedAt: string; areaId: string | null }
interface Home { areas: HomeArea[]; proposed: { id: string; name: string }[]; unsorted: number; feed: HomeFeedItem[]; decisions: HomeDecision[]; sessions: HomeSession[] }

const box = el<HTMLDivElement>("#home");
const errorBox = el<HTMLDivElement>("#error");
const search = el<HTMLInputElement>("#home-search");
let data: Home | null = null;

const hit = (q: string, ...parts: (string | null | undefined)[]) => !q || parts.some((p) => (p ?? "").toLowerCase().includes(q));
const areaName = (id: string | null) => data?.areas.find((a) => a.id === id)?.name ?? "unsorted";

function feedItem(f: HomeFeedItem): SafeHtml {
	const link = f.sessionId ? html`<a href="/?session=${encodeURIComponent(f.sessionId)}">session</a>` : html`<a href="/run.html?id=${encodeURIComponent(f.runId)}">run</a>`;
	return html`<li><span class="muted mono">${formatTime(f.at)}</span> ${f.text}${f.verified ? "" : html` <span class="home-tag">unverified</span>`} <span class="muted">· ${areaName(f.areaId)}${f.wiki ? ` · ${f.wiki}` : ""}</span> ${link}</li>`;
}

function list(items: SafeHtml[], empty: string): SafeHtml {
	return items.length > 0 ? html`<ul class="home-list">${items}</ul>` : html`<p class="muted">${empty}</p>`;
}

function areaCard(a: HomeArea): SafeHtml {
	return html`<a class="home-area" href="/area.html?id=${encodeURIComponent(a.id)}"><strong>${a.name}</strong> <span class="muted">${String(a.recent)} this week · ${String(a.wikis.length)} wikis</span><span class="home-scope muted">${a.scope}</span></a>`;
}

function render(): void {
	if (!data) return;
	const d = data;
	const q = search.value.trim().toLowerCase();
	const feed = d.feed.filter((f) => hit(q, f.text, f.wiki, areaName(f.areaId)));
	const decisions = d.decisions.filter((x) => hit(q, x.choice, x.reason, x.wiki, areaName(x.areaId)));
	const areas = d.areas.filter((a) => hit(q, a.name, a.scope, ...a.wikis.map((w) => `${w.name} ${w.summary ?? ""}`)) || (q !== "" && feed.some((f) => f.areaId === a.id)));
	const sessions = d.sessions.filter((s) => hit(q, s.title, s.cwd, areaName(s.areaId)));
	const pending = d.proposed.length > 0 ? html`<p class="home-note">${String(d.proposed.length)} proposed area(s) waiting for approval: ${d.proposed.map((p) => p.name).join(", ")}. Run <code>nexo areas list</code>.</p>` : "";
	const decisionItems = decisions.slice(0, 20).map((x) => html`<li><span class="muted mono">${formatTime(x.at)}</span> <strong>${x.choice}</strong>${x.reason ? html` <span class="muted">because ${x.reason}</span>` : ""} <span class="muted">· ${areaName(x.areaId)}</span></li>`);
	const sessionItems = sessions.map((s) => html`<li><a href="/?session=${encodeURIComponent(s.id)}">${s.title || s.id}</a> <span class="muted">${s.cwd} · ${formatTime(s.updatedAt)}</span></li>`);
	box.innerHTML = html`${pending}
<section><h2>Areas</h2><div class="home-areas">${areas.map((a) => areaCard(a))}</div></section>
<section><h2>Recent</h2>${list(feed.slice(0, 20).map(feedItem), "No activity yet. Each finished task adds a line here after it is scored.")}</section>
<section><h2>Decisions</h2>${list(decisionItems, "No decisions recorded yet.")}</section>
<section><h2>Recent sessions</h2>${list(sessionItems, "No sessions.")}</section>`.value;
}

search.addEventListener("input", render);
getJson<Home>("/api/home")
	.then((d) => {
		data = d;
		render();
	})
	.catch((error) => {
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	});
