import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { listSessionRows, resolveNexoPaths } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import { listHomeFolders, parseWikiMeta, resolveConfined } from "@nexo/tools";
import type { ApiContext } from "./api.ts";

const FEED_LIMIT = 50;
const DECISION_LIMIT = 50;

export interface HomeArea {
	id: string;
	name: string;
	scope: string;
	wikis: { name: string; summary?: string; pageCount: number; path: string }[];
	recent: number;
}

export interface HomeFeedItem {
	at: string;
	text: string;
	areaId: string | null;
	wiki: string | null;
	sessionId: string | null;
	runId: string;
	verified: boolean;
}

export interface HomeDecision {
	at: string;
	choice: string;
	reason: string;
	areaId: string | null;
	wiki: string | null;
	sessionId: string | null;
	runId: string;
}

export interface HomeSession {
	id: string;
	title: string;
	cwd: string;
	updatedAt: string;
	areaId: string | null;
}

export interface HomeResponse {
	areas: HomeArea[];
	proposed: { id: string; name: string }[];
	unsorted: number;
	feed: HomeFeedItem[];
	decisions: HomeDecision[];
	sessions: HomeSession[];
}

/** Reads a JSON-lines file newest first; unparseable lines are skipped. */
function readJsonl<T>(file: string, limit: number): T[] {
	if (!existsSync(file)) return [];
	const out: T[] = [];
	for (const line of readFileSync(file, "utf8").split("\n").reverse()) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			// skip a torn or hand-edited line
		}
		if (out.length >= limit) break;
	}
	return out;
}

function countPages(dir: string): number {
	let n = 0;
	const walk = (d: string) => {
		for (const f of readdirSync(d)) {
			if (f.startsWith(".") || f === "raw") continue;
			const p = join(d, f);
			if (statSync(p).isDirectory()) walk(p);
			else if (f.endsWith(".html") || f.endsWith(".md")) n++;
		}
	};
	try {
		walk(dir);
	} catch {
		// unreadable wiki: report what was counted
	}
	return n;
}

interface RawArea {
	id: string;
	name: string;
	scope: string;
	wikis?: string[];
	status?: string;
}

/** `GET /api/home`: approved areas with their wikis, the feed, decisions and recent sessions, read fresh on every call. */
export function homeResponse(ctx: ApiContext): HomeResponse {
	const dir = ctx.wikisDir ?? resolveNexoPaths().homeRoot;
	let raw: { areas?: RawArea[]; unsorted?: unknown[] } = {};
	try {
		raw = JSON.parse(readFileSync(join(dir, "areas.json"), "utf8"));
	} catch {
		raw = {};
	}
	const all = Array.isArray(raw.areas) ? raw.areas : [];
	const active = all.filter((a) => a.status === "active");
	const feed = readJsonl<HomeFeedItem>(join(dir, "feed.jsonl"), FEED_LIMIT).map((f) => ({ ...f, text: ctx.redact(String(f.text ?? "")) }));
	const decisions = readJsonl<HomeDecision>(join(dir, "decisions.jsonl"), DECISION_LIMIT).map((d) => ({ ...d, choice: ctx.redact(String(d.choice ?? "")), reason: ctx.redact(String(d.reason ?? "")) }));
	const folders = new Map(listHomeFolders(dir).map((f) => [f.name, f.dir]));
	const weekAgo = ctx.now().getTime() - 7 * 86_400_000;
	const areas: HomeArea[] = active.map((a) => ({
		id: a.id,
		name: a.name,
		scope: a.scope,
		wikis: (a.wikis ?? [])
			.filter((w) => folders.has(w))
			.map((w) => {
				let summary: string | undefined;
				try {
					summary = parseWikiMeta(readFileSync(join(folders.get(w) as string, "overview.html"), "utf8")).summary;
				} catch {
					summary = undefined;
				}
				return { name: w, summary, pageCount: countPages(folders.get(w) as string), path: relative(dir, folders.get(w) as string).split(sep).join("/") };
			}),
		recent: feed.filter((f) => f.areaId === a.id && Date.parse(f.at) >= weekAgo).length,
	}));
	const sessionArea = new Map<string, string>();
	for (const f of [...feed].reverse()) if (f.sessionId && f.areaId) sessionArea.set(f.sessionId, f.areaId);
	const sessions: HomeSession[] = listSessionRows(ctx.db, { limit: 15 }).map((s) => ({
		id: s.id,
		title: ctx.redact(s.title ?? ""),
		cwd: s.cwd,
		updatedAt: s.updatedAt,
		areaId: sessionArea.get(s.id) ?? null,
	}));
	return {
		areas,
		proposed: all.filter((a) => a.status === "proposed").map((a) => ({ id: a.id, name: a.name })),
		unsorted: Array.isArray(raw.unsorted) ? raw.unsorted.length : 0,
		feed,
		decisions,
		sessions,
	};
}

export interface HomePageItem { path: string; title: string; summary?: string; modifiedAt: string }
export interface HomeFolderResponse { area: string; name: string; pages: HomePageItem[] }
export interface HomePageResponse { path: string; title: string; summary?: string; updated?: string; content: string; modifiedAt: string }

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;

function confined(root: string, rel: string): string {
	try {
		return resolveConfined(root, rel);
	} catch {
		throw new NexoError({ code: "FORBIDDEN", message: `Path "${rel}" is outside the home folder`, context: { path: rel } });
	}
}

function titleOf(content: string, fallback: string): string {
	const m = /<title>([^<]*)<\/title>/i.exec(content.slice(0, 4096));
	return m?.[1]?.trim() || fallback;
}

/** `GET /api/home/folder?area=&name=`: the HTML pages of one folder, paths relative to the home root. */
export function homeFolderResponse(ctx: ApiContext, area: string, name: string): HomeFolderResponse {
	if (!SEGMENT.test(area) || !SEGMENT.test(name)) throw new NexoError({ code: "INVALID_REQUEST", message: "area and name must be lowercase slugs", context: { area, name } });
	const root = ctx.wikisDir ?? resolveNexoPaths().homeRoot;
	const dir = confined(root, `${area}/${name}`);
	if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new NexoError({ code: "NOT_FOUND", message: `No folder ${area}/${name}`, context: { area, name } });
	const realRoot = realpathSync(root);
	const pages: HomePageItem[] = [];
	const walk = (d: string) => {
		for (const f of readdirSync(d)) {
			if (f.startsWith(".") || f === "raw") continue;
			const p = join(d, f);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (f.endsWith(".html")) {
				const content = readFileSync(p, "utf8");
				pages.push({ path: relative(realRoot, p).split(sep).join("/"), title: ctx.redact(titleOf(content, f.slice(0, -5))), summary: parseWikiMeta(content).summary, modifiedAt: st.mtime.toISOString() });
			}
		}
	};
	walk(dir);
	pages.sort((a, b) => a.path.localeCompare(b.path));
	return { area, name, pages };
}

/** `GET /api/home/page?path=<area>/<folder>/<page>.html`: one HTML page, redacted. */
export function homePageResponse(ctx: ApiContext, relPath: string): HomePageResponse {
	const segs = relPath.split("/");
	if (!/^[A-Za-z0-9._/-]+\.html$/.test(relPath) || segs.length < 3 || segs.includes("..") || segs.includes(".")) {
		throw new NexoError({ code: "INVALID_REQUEST", message: "path must be <area>/<folder>/<page>.html", context: { path: relPath } });
	}
	const root = ctx.wikisDir ?? resolveNexoPaths().homeRoot;
	const file = confined(root, relPath);
	if (!existsSync(file) || !statSync(file).isFile()) throw new NexoError({ code: "NOT_FOUND", message: `No page ${relPath}`, context: { path: relPath } });
	const content = ctx.redact(readFileSync(file, "utf8"));
	const meta = parseWikiMeta(content);
	return { path: relPath, title: titleOf(content, (segs[segs.length - 1] ?? relPath).replace(/[.]html$/, "")), summary: meta.summary, updated: meta.updated, content, modifiedAt: statSync(file).mtime.toISOString() };
}
