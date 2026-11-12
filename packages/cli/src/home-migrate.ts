import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { resolveNexoPaths } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import { UNSORTED_AREA } from "@nexo/tools";
import { type CliIO, type CliOptions, usageError } from "./common.ts";

export interface HomeMove {
	from: string;
	to: string;
}
export interface HomePlan {
	folders: HomeMove[];
	files: HomeMove[];
	conflicts: string[];
}

const META_FILES = ["areas.json", "feed.jsonl", "decisions.jsonl"];
const MANIFEST = ".migrated-from-wikis.json";
const HOME_USAGE = "Usage: nexo home migrate [--apply | --undo]";

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Where each folder of the old wikis root goes: <home>/<area>/<name>, or <home>/unsorted/<name> when no active area lists it. */
export function planHomeMigration(oldRoot: string, newRoot: string): HomePlan {
	const plan: HomePlan = { folders: [], files: [], conflicts: [] };
	if (!isDir(oldRoot)) return plan;
	let areas: { id?: unknown; status?: unknown; wikis?: unknown }[] = [];
	try {
		const parsed = JSON.parse(readFileSync(join(oldRoot, "areas.json"), "utf8")) as { areas?: unknown };
		if (Array.isArray(parsed.areas)) areas = parsed.areas as typeof areas;
	} catch {
		areas = [];
	}
	const owner = new Map<string, string>();
	for (const a of areas) {
		if (a.status !== "active" || typeof a.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(a.id) || !Array.isArray(a.wikis)) continue;
		for (const w of a.wikis) if (typeof w === "string" && !owner.has(w)) owner.set(w, a.id);
	}
	for (const name of readdirSync(oldRoot).sort()) {
		if (name.startsWith(".")) continue;
		const from = join(oldRoot, name);
		if (!isDir(from)) continue;
		const to = join(newRoot, owner.get(name) ?? UNSORTED_AREA, name);
		if (existsSync(to)) plan.conflicts.push(to);
		else plan.folders.push({ from, to });
	}
	for (const f of META_FILES) {
		const from = join(oldRoot, f);
		if (!existsSync(from)) continue;
		const to = join(newRoot, f);
		if (existsSync(to)) plan.conflicts.push(to);
		else plan.files.push({ from, to });
	}
	return plan;
}

function htmlFiles(dir: string, out: string[] = []): string[] {
	for (const f of readdirSync(dir)) {
		if (f === ".git") continue;
		const p = join(dir, f);
		if (isDir(p)) htmlFiles(p, out);
		else if (f.endsWith(".html")) out.push(p);
	}
	return out;
}

const within = (p: string, root: string) => p === root || p.startsWith(root + sep);

/** After folders moved from `from` to `to`, rewrites relative links into another moved folder so they still resolve. Returns links changed. */
export function rewriteMovedLinks(moves: readonly HomeMove[]): number {
	let changed = 0;
	for (const m of moves) {
		if (!isDir(m.to)) continue;
		for (const file of htmlFiles(m.to)) {
			const oldFile = join(m.from, relative(m.to, file));
			const text = readFileSync(file, "utf8");
			let n = 0;
			const next = text.replace(/href="([^"#?:]+\.html)([#?][^"]*)?"/g, (whole: string, href: string, tail?: string) => {
				if (href.startsWith("/")) return whole;
				const target = resolve(dirname(oldFile), href);
				const owner = moves.find((x) => within(target, x.from));
				if (!owner) return whole;
				const rel = relative(dirname(file), join(owner.to, relative(owner.from, target))).split(sep).join("/");
				if (rel === href) return whole;
				n++;
				return `href="${rel}${tail ?? ""}"`;
			});
			if (n > 0) {
				writeFileSync(file, next);
				changed += n;
			}
		}
	}
	return changed;
}

function moveAll(moves: readonly HomeMove[], done: HomeMove[]): void {
	for (const m of moves) {
		mkdirSync(dirname(m.to), { recursive: true });
		renameSync(m.from, m.to);
		done.push(m);
	}
}

/** `nexo home migrate`: moves ~/.nexo/wikis/<name> to ~/.nexo/home/<area>/<name>. Dry run by default; --apply moves, --undo reverses. */
export function homeCommand(args: string[], io: CliIO, options: CliOptions): number {
	const [sub, ...rest] = args;
	if (sub !== "migrate") throw usageError(HOME_USAGE);
	const { values } = parseArgs({ args: rest, options: { apply: { type: "boolean" }, undo: { type: "boolean" } } });
	if (values.apply && values.undo) throw usageError(HOME_USAGE);
	const paths = resolveNexoPaths(options.env ?? process.env);
	const oldRoot = join(paths.home, "wikis");
	const newRoot = paths.homeRoot;
	const manifestFile = join(newRoot, MANIFEST);
	if (values.undo) {
		if (!existsSync(manifestFile)) throw new NexoError({ code: "NOT_FOUND", message: `No migration manifest at ${manifestFile}`, context: { manifest: manifestFile } });
		const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { moves: HomeMove[]; folders: HomeMove[] };
		const back = [...manifest.moves].reverse().map((m) => ({ from: m.to, to: m.from }));
		for (const m of back) if (existsSync(m.to)) throw new NexoError({ code: "CONFLICT", message: `${m.to} already exists; undo would overwrite it`, context: { path: m.to } });
		moveAll(back, []);
		const links = rewriteMovedLinks(manifest.folders.map((m) => ({ from: m.to, to: m.from })));
		rmSync(manifestFile);
		io.stdout.write(`Moved ${back.length} entries back to ${oldRoot} and restored ${links} links.\n`);
		return 0;
	}
	const plan = planHomeMigration(oldRoot, newRoot);
	if (plan.folders.length + plan.files.length + plan.conflicts.length === 0) {
		io.stdout.write(`Nothing to migrate in ${oldRoot}.\n`);
		return 0;
	}
	for (const m of [...plan.folders, ...plan.files]) io.stdout.write(`  ${relative(paths.home, m.from)} -> ${relative(paths.home, m.to)}\n`);
	if (plan.conflicts.length > 0) {
		throw new NexoError({ code: "CONFLICT", message: `Already exists: ${plan.conflicts.join(", ")}`, hint: "Move or remove those paths, then run again", context: { conflicts: plan.conflicts } });
	}
	if (!values.apply) {
		io.stdout.write("Dry run: nothing moved. Run `nexo home migrate --apply` to move, and `--undo` to reverse it.\n");
		return 0;
	}
	mkdirSync(newRoot, { recursive: true });
	const done: HomeMove[] = [];
	try {
		moveAll([...plan.folders, ...plan.files], done);
	} finally {
		const moved = new Set(done);
		writeFileSync(manifestFile, `${JSON.stringify({ at: new Date().toISOString(), moves: done, folders: plan.folders.filter((m) => moved.has(m)) }, null, 2)}\n`);
	}
	const links = rewriteMovedLinks(plan.folders);
	io.stdout.write(`Moved ${done.length} entries into ${newRoot} and rewrote ${links} links. Undo with: nexo home migrate --undo\n`);
	return 0;
}
