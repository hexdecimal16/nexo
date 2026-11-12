import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { dataBlock } from "@nexo/scorers";
import type { RunRow, ScoreRow, SpanRow } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import { listHomeFolders } from "@nexo/tools";
import { type Static, Type } from "typebox";
import { type ChargedCallDeps, structuredLearnCall } from "./caller.ts";

/** Life areas live in the wikis directory as data. Code never names an area; the user approves every new one. */
export const AREAS_FILE = "areas.json";
export const FEED_FILE = "feed.jsonl";
export const DECISIONS_FILE = "decisions.jsonl";
/** Unsorted tasks sharing a label before that label is proposed as a new area. */
export const PROPOSAL_THRESHOLD = 3;
/** Runs scoring below this get an unverified feed line and no filed decisions. */
export const FILE_SCORE_FLOOR = 0.6;
const MAX_UNSORTED = 200;

export interface Area {
	id: string;
	name: string;
	/** What belongs here and what does not; the assignment step matches against it. */
	scope: string;
	examples: string[];
	/** Old names and synonyms; a label matching one never becomes a new area. */
	aliases: string[];
	wikis: string[];
	/** Proposed areas are never assigned to until the user approves them. */
	status: "active" | "proposed";
	createdAt: string;
}

export interface UnsortedItem {
	runId: string;
	label: string;
	reason: string;
	at: string;
}

export interface AreaRegistry {
	version: 1;
	areas: Area[];
	unsorted: UnsortedItem[];
}

export function emptyRegistry(): AreaRegistry {
	return { version: 1, areas: [], unsorted: [] };
}

export function normalizeLabel(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function slug(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "area";
}

/** Reads the registry; a missing file is an empty registry. An unreadable file throws so it is never overwritten. */
export function readRegistry(wikisDir: string): AreaRegistry {
	const file = join(wikisDir, AREAS_FILE);
	if (!existsSync(file)) return emptyRegistry();
	const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AreaRegistry>;
	return { version: 1, areas: Array.isArray(parsed.areas) ? parsed.areas : [], unsorted: Array.isArray(parsed.unsorted) ? parsed.unsorted : [] };
}

/** Writes the registry atomically (temp file, then rename). */
export function writeRegistry(wikisDir: string, registry: AreaRegistry): void {
	mkdirSync(wikisDir, { recursive: true });
	const file = join(wikisDir, AREAS_FILE);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
	renameSync(tmp, file);
}

export function areaMatches(area: Area, label: string): boolean {
	const n = normalizeLabel(label);
	return n !== "" && [area.id, area.name, ...area.aliases].some((x) => normalizeLabel(x) === n);
}

/** Queues an unsorted task. Once PROPOSAL_THRESHOLD queued tasks share a label no area covers, that label becomes a proposed area. */
export function recordUnsorted(registry: AreaRegistry, item: UnsortedItem): { registry: AreaRegistry; proposed: Area | null } {
	const unsorted = [...registry.unsorted, item].slice(-MAX_UNSORTED);
	const n = normalizeLabel(item.label);
	if (n === "" || registry.areas.some((a) => areaMatches(a, item.label))) return { registry: { ...registry, unsorted }, proposed: null };
	const same = unsorted.filter((u) => normalizeLabel(u.label) === n);
	if (same.length < PROPOSAL_THRESHOLD) return { registry: { ...registry, unsorted }, proposed: null };
	let id = slug(item.label);
	for (let i = 2; registry.areas.some((a) => a.id === id); i++) id = `${slug(item.label)}-${i}`;
	const proposed: Area = {
		id,
		name: item.label.trim(),
		scope: `Proposed from ${same.length} unsorted tasks. Write a scope note before approving.`,
		examples: same.slice(-3).map((u) => u.reason),
		aliases: [],
		wikis: [],
		status: "proposed",
		createdAt: item.at,
	};
	return { registry: { ...registry, unsorted, areas: [...registry.areas, proposed] }, proposed };
}

/** Makes a proposed area active. Only a user action should call this. */
export function approveArea(registry: AreaRegistry, id: string): AreaRegistry {
	const area = registry.areas.find((a) => a.id === id);
	if (!area) throw new NexoError({ code: "NOT_FOUND", message: `No area "${id}"`, context: { id } });
	if (area.status === "active") throw new NexoError({ code: "CONFLICT", message: `Area "${id}" is already active`, context: { id } });
	return { ...registry, areas: registry.areas.map((a) => (a.id === id ? { ...a, status: "active" as const } : a)) };
}

/** Mean value of the latest scoring round, or null when the run has no valued scores. */
export function runScoreMean(scores: readonly ScoreRow[]): number | null {
	if (scores.length === 0) return null;
	const last = Math.max(...scores.map((s) => s.round));
	const values = scores.filter((s) => s.round === last && typeof s.value === "number").map((s) => s.value as number);
	return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** The run's ask_user questions and answers, the most reliable record of the user's decisions. */
export function askUserAnswers(spans: readonly SpanRow[]): string[] {
	return spans
		.filter((s) => s.kind === "tool_call" && s.name === "ask_user" && s.status === "ok")
		.map((s) => {
			const attrs = (s.attrs ?? {}) as unknown as Record<string, unknown>;
			const args = (attrs.args ?? {}) as { questions?: unknown };
			return JSON.stringify({ questions: args.questions, answer: attrs.result ?? attrs.output ?? attrs.text }).slice(0, 1500);
		})
		.slice(-5);
}

/** HTML wiki pages (relative to the wikis dir) that the run's write and edit tool calls changed. */
export function wikiPagesTouched(spans: readonly SpanRow[], wikisDir: string): string[] {
	const out: string[] = [];
	for (const s of spans) {
		if (s.kind !== "tool_call" || s.status !== "ok" || (s.name !== "write" && s.name !== "edit")) continue;
		const path = ((s.attrs ?? {}) as unknown as { args?: { path?: unknown } }).args?.path;
		if (typeof path !== "string" || !isAbsolute(path)) continue;
		const rel = relative(wikisDir, path);
		if (!rel || rel.startsWith("..") || isAbsolute(rel) || !rel.endsWith(".html")) continue;
		out.push(rel.split(sep).join("/"));
	}
	return out;
}

function listWikis(wikisDir: string): string[] {
	return listHomeFolders(wikisDir).map((f) => f.name);
}

export const AssignmentSchema = Type.Object(
	{
		areaId: Type.String({ minLength: 1, maxLength: 64 }),
		unsortedLabel: Type.Optional(Type.String({ maxLength: 60 })),
		wiki: Type.Optional(Type.String({ maxLength: 64 })),
		feed: Type.String({ maxLength: 240 }),
		decisions: Type.Array(Type.Object({ choice: Type.String({ minLength: 1, maxLength: 300 }), reason: Type.String({ maxLength: 300 }) }, { additionalProperties: false }), { maxItems: 5 }),
	},
	{ additionalProperties: false },
);
export type Assignment = Static<typeof AssignmentSchema>;

export const ASSIGN_SYSTEM = `You file a finished task into the user's life areas.
The areas are a fixed list the user approved. Pick the one area whose scope fits the task and answer with its id. Never invent an area id.
If no area fits, set areaId to "unsorted" and give unsortedLabel: a short, broad name (one or two words) for the area the task would need. Prefer broad names such as "travel" over narrow ones such as "goa trip", and reuse a label from the queued list when it fits.
wiki: the existing wiki this task belongs to, from the wiki list, or omit it.
feed: one past-tense line for the user's home feed saying what happened, under 160 characters. Use "" for trivial tasks (small talk, a one-off lookup worth no record).
decisions: choices the user made in this task (answers to questions, or an option they picked or stated), each with the choice and the reason they gave. Only the user's choices, never the agent's own. Use [] when there are none.`;

export function assignPrompt(input: { registry: AreaRegistry; wikis: string[]; cwd?: string; instruction: string; answers: string[]; output: string }): string {
	const areas = input.registry.areas.filter((a) => a.status === "active").map((a) => ({ id: a.id, name: a.name, scope: a.scope, examples: a.examples, aliases: a.aliases, wikis: a.wikis }));
	const queued = [...new Set(input.registry.unsorted.map((u) => normalizeLabel(u.label)).filter(Boolean))].slice(-30);
	return [
		`# Areas\n${JSON.stringify(areas, null, 1)}`,
		`# Queued unsorted labels\n${queued.join(", ") || "(none)"}`,
		`# Wikis\n${input.wikis.join(", ") || "(none)"}`,
		`# Working folder\n${input.cwd ?? "(unknown)"}`,
		`# User instruction\n${dataBlock("instruction", input.instruction)}`,
		`# Questions the user answered\n${dataBlock("answers", input.answers.join("\n") || "(none)")}`,
		`# Final output\n${dataBlock("output", input.output.slice(0, 4000))}`,
	].join("\n\n");
}

export interface AssignResult {
	areaId: string | null;
	feed: boolean;
	decisions: number;
	proposed: string | null;
	verified: boolean;
}

/** After a scored run: files it into an approved area (or the unsorted queue), appends a feed line and, for verified runs, the user's decisions. Does nothing until an area is active. */
export async function assignRun(
	deps: ChargedCallDeps,
	input: { run: RunRow; output: string; spans: readonly SpanRow[]; scores: readonly ScoreRow[]; cwd?: string; extraPages?: readonly string[] },
): Promise<AssignResult> {
	const none: AssignResult = { areaId: null, feed: false, decisions: 0, proposed: null, verified: false };
	const wikisDir = deps.env.deps.paths?.homeRoot;
	if (!wikisDir || !existsSync(wikisDir)) return none;
	if (!input.output || input.output.trim().length < 50) return none;
	const registry = readRegistry(wikisDir);
	const active = registry.areas.filter((a) => a.status === "active");
	if (active.length === 0) return none;
	const wikis = listWikis(wikisDir);
	const reply = await structuredLearnCall(deps, AssignmentSchema, {
		system: ASSIGN_SYSTEM,
		user: assignPrompt({ registry, wikis, cwd: input.cwd, instruction: input.run.instruction, answers: askUserAnswers(input.spans), output: input.output }),
		tier: "curator",
	});
	const now = deps.env.now().toISOString();
	const redact = deps.env.deps.redact;
	const mean = runScoreMean(input.scores);
	const verified = mean !== null && mean >= FILE_SCORE_FLOOR;
	const known = active.find((a) => a.id === reply.areaId);
	const wiki = reply.wiki && wikis.includes(reply.wiki) ? reply.wiki : null;
	let proposed: string | null = null;
	if (!known) {
		const label = (reply.unsortedLabel ?? (reply.areaId === "unsorted" ? "" : reply.areaId)).trim();
		if (label) {
			const next = recordUnsorted(registry, { runId: input.run.id, label, reason: redact((reply.feed.trim() || input.run.instruction).slice(0, 200)), at: now });
			writeRegistry(wikisDir, next.registry);
			proposed = next.proposed?.id ?? null;
		}
	}
	const areaId = known?.id ?? null;
	const pages = [...new Set([...wikiPagesTouched(input.spans, wikisDir), ...(input.extraPages ?? [])])].filter((x) => x.endsWith(".html")).slice(0, 5);
	const base = { at: now, runId: input.run.id, sessionId: input.run.sessionId ?? null, areaId, wiki, pages };
	let fed = false;
	if (reply.feed.trim()) {
		appendFileSync(join(wikisDir, FEED_FILE), `${JSON.stringify({ ...base, text: redact(reply.feed.trim()), verified })}\n`);
		fed = true;
	}
	let decisions = 0;
	if (verified) {
		for (const d of reply.decisions) {
			appendFileSync(join(wikisDir, DECISIONS_FILE), `${JSON.stringify({ ...base, choice: redact(d.choice), reason: redact(d.reason) })}\n`);
			decisions++;
		}
	}
	return { areaId, feed: fed, decisions, proposed, verified };
}
