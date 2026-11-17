// Home: what is running and what needs you, the life areas as tiles, and one timeline of filed work and decisions.
import type { RunListResponse } from "../lib/api-types.ts";
import { renderError, runLink, sessionLink } from "../lib/common-view.ts";
import { formatTime, truncate } from "../lib/format.ts";
import { html, type SafeHtml } from "../lib/html.ts";
import { asErrorBody, el, getJson } from "./api.ts";

interface HomeWiki { name: string; summary?: string; pageCount: number; path: string }
interface HomeArea { id: string; name: string; scope: string; wikis: HomeWiki[]; recent: number }
interface HomeFeedItem { at: string; text: string; areaId: string | null; wiki: string | null; sessionId: string | null; runId: string; verified: boolean; pages?: string[] }
interface HomeDecision { at: string; choice: string; reason: string; areaId: string | null; wiki: string | null; sessionId: string | null; runId: string }
interface HomeSession { id: string; title: string; cwd: string; updatedAt: string; areaId: string | null }
interface Home { areas: HomeArea[]; proposed: { id: string; name: string }[]; unsorted: number; feed: HomeFeedItem[]; decisions: HomeDecision[]; sessions: HomeSession[] }
interface ReviewItem { runId: string; instruction: string; status: string; score: number | null; startedAt: string }
interface Entry { at: string; kind: "done" | "decision"; body: SafeHtml; meta: SafeHtml; text: string }

const HUES = 6;
const box = el<HTMLDivElement>("#home");
const errorBox = el<HTMLDivElement>("#error");
const search = el<HTMLInputElement>("#home-search");
const greeting = el<HTMLHeadingElement>("#greeting");
const dateLine = el<HTMLParagraphElement>("#home-date");
let data: Home | null = null;
let running: RunListResponse["runs"] = [];
let review: ReviewItem[] = [];

const hit = (q: string, ...parts: (string | null | undefined)[]) => !q || parts.some((p) => (p ?? "").toLowerCase().includes(q));
const areaName = (id: string | null) => data?.areas.find((a) => a.id === id)?.name ?? "unsorted";
const hueOf = (id: string | null): string => {
	const i = data ? data.areas.findIndex((a) => a.id === id) : -1;
	return i < 0 ? "none" : String(i % HUES);
};
const chip = (id: string | null): SafeHtml => html`<span class="chip" data-hue="${hueOf(id)}">${areaName(id)}</span>`;
const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function dayLabel(d: Date): string {
	const today = new Date();
	const yesterday = new Date();
	yesterday.setDate(today.getDate() - 1);
	if (dayKey(d) === dayKey(today)) return "Today";
	if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
	return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

function ago(iso: string): string {
	const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (!(m >= 0)) return formatTime(iso);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function header(): void {
	const now = new Date();
	const h = now.getHours();
	greeting.textContent = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
	dateLine.textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function pageLinks(f: { pages?: string[]; wiki: string | null; areaId: string | null }): SafeHtml {
	const pages = (f.pages ?? []).filter((p) => p.endsWith(".html") && p.includes("/") && !p.includes(".."));
	if (pages.length > 0) return html`${pages.map((p) => html`<a class="feed-page" href="/page.html?path=${encodeURIComponent(p)}">${p.slice(p.lastIndexOf("/") + 1, -5)}</a> `)}`;
	return f.wiki && f.areaId ? html`<a class="feed-page" href="/page.html?path=${encodeURIComponent(`${f.areaId}/${f.wiki}/index.html`)}">${f.wiki}</a>` : html``;
}

function panel(title: SafeHtml | string, count: number | null, state: string, items: SafeHtml[], empty: string): SafeHtml {
	return html`<section class="today-panel" data-state="${state}"><h2><span>${title}</span>${count === null ? "" : html`<span class="today-count">${String(count)}</span>`}</h2>${items.length > 0 ? html`<ul class="today-list">${items}</ul>` : html`<p class="today-empty">${empty}</p>`}</section>`;
}

function strip(d: Home, q: string): SafeHtml {
	const live = running.filter((r) => hit(q, r.instruction));
	const runItems = live.slice(0, 4).map((r) => html`<li class="live"><a href="${runLink(r.id)}">${truncate(r.instruction, 90)}</a></li>`);
	const proposals = d.proposed.length > 0 ? [html`<li>${String(d.proposed.length)} proposed area${d.proposed.length === 1 ? "" : "s"} to approve: ${d.proposed.map((p) => p.name).join(", ")}. Run <code>nexo areas list</code>.</li>`] : [];
	const toReview = review.filter((r) => hit(q, r.instruction)).slice(0, 4).map((r) => html`<li><a href="${runLink(r.runId)}">${truncate(r.instruction, 80)}</a> <span class="muted">${r.score === null ? "unscored" : `score ${Math.round(r.score * 100) / 100}`}</span></li>`);
	const needs = review.length + d.proposed.length;
	const sessions = d.sessions.filter((s) => hit(q, s.title, s.cwd, areaName(s.areaId))).slice(0, 4).map((s) => html`<li><a href="${sessionLink(s.id)}">${truncate(s.title || s.id, 70)}</a> <span class="muted">${ago(s.updatedAt)}</span></li>`);
	return html`${panel("Running", live.length, live.length > 0 ? "running" : "idle", runItems, "No runs in progress.")}${panel(html`<a href="/runs.html?tab=review">Needs you</a>`, needs, needs > 0 ? "attention" : "idle", [...proposals, ...toReview], "Nothing waiting for a verdict or an approval.")}${panel("Pick up", null, "idle", sessions, "No recent sessions.")}`;
}

function tile(d: Home, a: HomeArea): SafeHtml {
	const week = Array.from({ length: 7 }, (_, k) => {
		const day = new Date();
		day.setDate(day.getDate() - (6 - k));
		const key = dayKey(day);
		return d.feed.filter((f) => f.areaId === a.id && dayKey(new Date(f.at)) === key).length;
	});
	const total = week.reduce((s, n) => s + n, 0);
	const cells = week.map((n) => html`<span data-level="${String(Math.min(n, 3))}"></span>`);
	const wikis = [...a.wikis].sort((x, y) => y.pageCount - x.pageCount).slice(0, 4).map((w) => html`<li><a href="/page.html?path=${encodeURIComponent(`${w.path}/index.html`)}">${w.name}</a></li>`);
	return html`<article class="tile" data-hue="${hueOf(a.id)}"><h3><a href="/area.html?id=${encodeURIComponent(a.id)}">${a.name}</a></h3><p class="tile-scope">${a.scope}</p>${wikis.length > 0 ? html`<ul class="tile-wikis" aria-label="Wikis">${wikis}</ul>` : html`<p class="tile-scope">No wikis yet.</p>`}<div class="tile-foot"><span>${String(a.recent)} this week · ${String(a.wikis.length)} ${a.wikis.length === 1 ? "wiki" : "wikis"}</span><span class="week" role="img" aria-label="${`${total} tasks filed in the last 7 days`}" title="Tasks filed per day, last 7 days">${cells}</span></div></article>`;
}

function timeline(d: Home, q: string): SafeHtml {
	const entries: Entry[] = [
		...d.feed.map((f): Entry => {
			const link = f.sessionId ? html`<a href="${sessionLink(f.sessionId)}">session</a>` : html`<a href="${runLink(f.runId)}">run</a>`;
			return { at: f.at, kind: "done", text: `${f.text} ${f.wiki ?? ""} ${areaName(f.areaId)}`, body: html`${f.text}${f.verified ? "" : html` <span class="home-tag">unverified</span>`}`, meta: html`${chip(f.areaId)} ${pageLinks(f)} ${link}` };
		}),
		...d.decisions.map((x): Entry => ({ at: x.at, kind: "decision", text: `${x.choice} ${x.reason} ${x.wiki ?? ""} ${areaName(x.areaId)}`, body: html`<span class="tl-kind">Decided</span> <strong>${x.choice}</strong>${x.reason ? ` because ${x.reason}` : ""}`, meta: html`${chip(x.areaId)}${x.wiki ? html` <span>${x.wiki}</span>` : ""}` })),
	]
		.filter((e) => hit(q, e.text))
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
		.slice(0, 40);
	if (entries.length === 0) return html`<p class="muted">${q ? "Nothing in the timeline matches." : "No activity yet. Each finished task adds a line here after it is scored."}</p>`;
	const days: { label: string; items: Entry[] }[] = [];
	for (const e of entries) {
		const label = dayLabel(new Date(e.at));
		const last = days[days.length - 1];
		if (last && last.label === label) last.items.push(e);
		else days.push({ label, items: [e] });
	}
	return html`${days.map((g) => html`<div class="tl-day"><h3>${g.label}</h3><ol class="tl">${g.items.map((e) => html`<li data-kind="${e.kind}"><time datetime="${e.at}">${clock(e.at)}</time><div class="tl-body">${e.body}<div class="tl-meta">${e.meta}</div></div></li>`)}</ol></div>`)}`;
}

function render(): void {
	if (!data) return;
	const d = data;
	const q = search.value.trim().toLowerCase();
	const areas = d.areas.filter((a) => hit(q, a.name, a.scope, ...a.wikis.map((w) => `${w.name} ${w.summary ?? ""}`)) || (q !== "" && d.feed.some((f) => f.areaId === a.id && hit(q, f.text))));
	box.innerHTML = html`<div class="today">${strip(d, q)}</div>
<section><h2>Areas</h2>${areas.length > 0 ? html`<div class="tiles">${areas.map((a) => tile(d, a))}</div>` : html`<p class="muted">No areas match.</p>`}</section>
<section class="tl-wrap"><h2>Timeline</h2>${timeline(d, q)}</section>`.value;
}

header();
search.addEventListener("input", render);
getJson<Home>("/api/home")
	.then((d) => {
		data = d;
		render();
	})
	.catch((error) => {
		box.innerHTML = "";
		errorBox.innerHTML = renderError(asErrorBody(error)).value;
	});
getJson<RunListResponse>("/api/runs?limit=25")
	.then((r) => {
		running = r.runs.filter((x) => x.status === "running");
		render();
	})
	.catch(() => undefined);
getJson<{ items: ReviewItem[] }>("/api/review-queue?limit=5")
	.then((r) => {
		review = r.items;
		render();
	})
	.catch(() => undefined);
