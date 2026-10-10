import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createTwoFilesPatch } from "diff";
import { resolveConfined } from "./confine.ts";

export interface ChangeSummary {
	path: string;
	kind: "created" | "modified" | "deleted" | "unchanged";
}

export interface ChangeTracker {
	beforeWrite(path: string): void;
	finalize(): ChangeSummary[];
}

function writeCopy(base: string, rel: string, content: string): void {
	const target = join(base, rel);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

/**
 * Records the original content of files before the agent first writes them, and diffs them at finalize.
 * Paths may use any spelling of the workspace (raw tmpdir or realpath); they are resolved through `resolveConfined`.
 */
export function createChangeTracker(workspaceRoot: string, changesDir: string): ChangeTracker {
	const rootReal = realpathSync(workspaceRoot);
	const originals = new Map<string, string | null>();

	return {
		beforeWrite(path) {
			const absPath = resolveConfined(rootReal, path);
			const rel = relative(rootReal, absPath);
			if (originals.has(rel)) return;
			const original = existsSync(absPath) ? readFileSync(absPath, "utf8") : null;
			originals.set(rel, original);
			if (original !== null) writeCopy(join(changesDir, "before"), rel, original);
		},
		finalize() {
			const summaries: ChangeSummary[] = [];
			let patch = "";
			for (const rel of [...originals.keys()].sort()) {
				const before = originals.get(rel) ?? null;
				const abs = join(rootReal, rel);
				const after = existsSync(abs) ? readFileSync(abs, "utf8") : null;
				const kind: ChangeSummary["kind"] =
					before === after ? "unchanged" : before === null ? "created" : after === null ? "deleted" : "modified";
				summaries.push({ path: rel, kind });
				if (kind === "unchanged") continue;
				if (after !== null) writeCopy(join(changesDir, "after"), rel, after);
				patch += createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before ?? "", after ?? "");
			}
			mkdirSync(changesDir, { recursive: true });
			writeFileSync(join(changesDir, "changes.diff"), patch);
			return summaries;
		},
	};
}
