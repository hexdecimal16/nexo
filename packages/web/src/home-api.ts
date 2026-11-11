import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listSessionRows, resolveNexoPaths } from "@nexo/store";
import { parseWikiMeta } from "@nexo/tools";
import type { ApiContext } from "./api.ts";

const FEED_LIMIT = 50;
const DECISION_LIMIT = 50;

export interface HomeArea {
	id: string;
	name: string;
	scope: string;
	wikis: { name: string; summary?: string; pageCount: number }[];
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
	const dir = ctx.wikisDir ?? resolveNexoPaths().wikis;
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
	const weekAgo = ctx.now().getTime() - 7 * 86_400_000;
	const areas: HomeArea[] = active.map((a) => ({
		id: a.id,
		name: a.name,
		scope: a.scope,
		wikis: (a.wikis ?? [])
			.filter((w) => /^[a-z0-9-]+$/.test(w) && existsSync(join(dir, w)))
			.map((w) => {
				let summary: string | undefined;
				try {
					summary = parseWikiMeta(readFileSync(join(dir, w, "overview.html"), "utf8")).summary;
				} catch {
					summary = undefined;
				}
				return { name: w, summary, pageCount: countPages(join(dir, w)) };
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
