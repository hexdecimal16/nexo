import { execFile } from "node:child_process";
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "@earendil-works/pi-tui";

const MAX_FILES = 20_000;
const MAX_DEPTH = 8;
const MAX_RESULTS = 20;
const CACHE_MS = 3000;
const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", "dist", "build", "target", ".next", ".cache", "__pycache__", ".venv", "venv"]);

/** An `@` token that starts a word (or follows an opening bracket): `@src/ap` or an unclosed `@"my fi`. */
const AT_TOKEN = /(?:^|[\s([{<`])(@"[^"]*|@[^\s"]*)$/;

export interface FileEntry {
	path: string;
	isDirectory: boolean;
}

/** Finds the `fd` binary (`fd`, `fdfind` on Debian/Ubuntu, `fd.exe` on Windows) on PATH; null when absent. */
export function findFd(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
	const names = platform === "win32" ? ["fd.exe"] : ["fd", "fdfind"];
	const pathVar = env.PATH ?? env.Path ?? "";
	for (const dir of pathVar.split(delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

function gitFiles(cwd: string): Promise<string[] | null> {
	return new Promise((resolve) => {
		execFile("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 5000, windowsHide: true }, (error, stdout) => {
			if (error) return resolve(null);
			const files = stdout.split("\0").filter(Boolean);
			resolve(files.length > 0 ? files.slice(0, MAX_FILES) : null);
		});
	});
}

/** Breadth-first directory walk used outside git repos. Skips dependency and build directories; bounded by depth and file count. */
export function walkFiles(cwd: string): string[] {
	const files: string[] = [];
	const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
	while (queue.length > 0 && files.length < MAX_FILES) {
		const { rel, depth } = queue.shift() as { rel: string; depth: number };
		let dirents: Dirent[];
		try {
			dirents = readdirSync(rel ? join(cwd, rel) : cwd, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const d of dirents) {
			const childRel = rel ? `${rel}/${d.name}` : d.name;
			if (d.isDirectory()) {
				if (!SKIP_DIRS.has(d.name) && depth < MAX_DEPTH) queue.push({ rel: childRel, depth: depth + 1 });
			} else if (d.isFile()) {
				files.push(childRel);
				if (files.length >= MAX_FILES) break;
			}
		}
	}
	return files;
}

/** Files plus every parent directory, as forward-slash paths relative to the project root (directories end in `/`). */
export function withDirectories(files: readonly string[]): FileEntry[] {
	const dirs = new Set<string>();
	for (const file of files) {
		const parts = file.split("/");
		for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join("/")}/`);
	}
	return [...[...dirs].map((path) => ({ path, isDirectory: true })), ...files.map((path) => ({ path, isDirectory: false }))];
}

function isSubsequence(text: string, query: string): boolean {
	let i = 0;
	for (const ch of text) if (ch === query[i] && ++i === query.length) return true;
	return query.length === 0;
}

export function scoreEntry(path: string, isDirectory: boolean, query: string): number {
	if (!query) return 1;
	const p = path.toLowerCase();
	const name = (isDirectory ? p.slice(0, -1) : p).split("/").pop() ?? p;
	let score: number;
	if (name.startsWith(query)) score = 100;
	else if (name.includes(query)) score = 80;
	else if (p.includes(query)) score = 60;
	else if (isSubsequence(p, query)) score = 30;
	else return 0;
	return isDirectory ? score + 5 : score;
}

/**
 * Autocomplete for slash commands and `@file` mentions that needs no external binary. `@` suggestions come from
 * `git ls-files` (respects .gitignore) or a bounded directory walk; everything else is delegated to pi-tui.
 */
class NodeFileAutocompleteProvider implements AutocompleteProvider {
	private readonly inner: CombinedAutocompleteProvider;
	private readonly cwd: string;
	private cache: { at: number; entries: Promise<FileEntry[]> } | null = null;

	constructor(commands: (SlashCommand | AutocompleteItem)[], cwd: string) {
		this.cwd = cwd;
		this.inner = new CombinedAutocompleteProvider(commands, cwd, null);
	}

	private entries(): Promise<FileEntry[]> {
		const now = Date.now();
		if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.entries;
		const entries = (async () => withDirectories((await gitFiles(this.cwd)) ?? walkFiles(this.cwd)))();
		this.cache = { at: now, entries };
		return entries;
	}

	async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const match = AT_TOKEN.exec(before);
		if (!match) return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
		const prefix = match[1] as string;
		const quoted = prefix.startsWith('@"');
		const query = prefix.slice(quoted ? 2 : 1).replace(/\\/g, "/").toLowerCase();
		const entries = await this.entries();
		if (options.signal.aborted) return null;
		const depth = (path: string) => path.split("/").filter(Boolean).length;
		const ranked = entries
			.map((entry) => ({ entry, score: scoreEntry(entry.path, entry.isDirectory, query) }))
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score || depth(a.entry.path) - depth(b.entry.path) || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
			.slice(0, MAX_RESULTS);
		if (ranked.length === 0) return null;
		const items = ranked.map(({ entry }): AutocompleteItem => {
			const bare = entry.isDirectory ? entry.path.slice(0, -1) : entry.path;
			const name = bare.split("/").pop() ?? bare;
			const needsQuotes = quoted || /\s/.test(entry.path);
			return {
				value: needsQuotes ? `@"${entry.path}"` : `@${entry.path}`,
				label: entry.isDirectory ? `${name}/` : name,
				description: bare,
			};
		});
		return { items, prefix };
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
		return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return this.inner.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
	}
}

/**
 * Slash-command and `@file` autocomplete for the editor. Uses `fd` when it is installed (faster on huge trees);
 * otherwise falls back to a Node implementation so `@` works on every platform without extra installs.
 */
export function createAutocompleteProvider(commands: (SlashCommand | AutocompleteItem)[], cwd: string, fdPath: string | null = findFd()): AutocompleteProvider {
	if (fdPath) return new CombinedAutocompleteProvider(commands, cwd, fdPath);
	return new NodeFileAutocompleteProvider(commands, cwd);
}
