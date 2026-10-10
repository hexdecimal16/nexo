import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { NexoError } from "@nexo/telemetry";
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

function writeCopy(base: string, rel: string, content: string, redact: (s: string) => string): void {
	const target = join(base, rel);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, redact(content));
}

/**
 * Records the original content of files before the agent first writes them, and diffs them at finalize.
 * Everything written under `changesDir` passes through `redact`. Paths may use any spelling of the workspace (raw tmpdir or realpath); they are resolved through `resolveConfined`.
 */
export function createChangeTracker(workspaceRoot: string, changesDir: string, redact: (s: string) => string): ChangeTracker {
	const rootReal = realpathSync(workspaceRoot);
	const originals = new Map<string, string | null>();

	return {
		beforeWrite(path) {
			const absPath = resolveConfined(rootReal, path);
			const rel = relative(rootReal, absPath);
			if (originals.has(rel)) return;
			if (existsSync(absPath) && statSync(absPath).isDirectory()) {
				throw new NexoError({
					code: "TOOL_DENIED",
					message: `Path "${path}" is a directory; only files can be written`,
					hint: "Write to a file path inside the directory",
					context: { path },
				});
			}
			const original = existsSync(absPath) ? readFileSync(absPath, "utf8") : null;
			originals.set(rel, original);
			if (original !== null) writeCopy(join(changesDir, "before"), rel, original, redact);
		},
		finalize() {
			const summaries: ChangeSummary[] = [];
			let patch = "";
			for (const rel of [...originals.keys()].sort()) {
				const before = originals.get(rel) ?? null;
				const abs = resolveConfined(rootReal, rel);
				const after = existsSync(abs) ? readFileSync(abs, "utf8") : null;
				const kind: ChangeSummary["kind"] =
					before === after ? "unchanged" : before === null ? "created" : after === null ? "deleted" : "modified";
				summaries.push({ path: rel, kind });
				if (kind === "unchanged") continue;
				if (after !== null) writeCopy(join(changesDir, "after"), rel, after, redact);
				patch += createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before ?? "", after ?? "");
			}
			mkdirSync(changesDir, { recursive: true });
			writeFileSync(join(changesDir, "changes.diff"), redact(patch));
			return summaries;
		},
	};
}
