import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { NexoError } from "@nexo/telemetry";

/** Absolute form of `target` (relative to `base`) with its deepest existing ancestor resolved through realpath. */
export function canonicalPath(target: string, base: string = process.cwd()): string {
	const absolute = isAbsolute(target) ? resolve(target) : resolve(base, target);
	let probe = absolute;
	while (!existsSync(probe)) probe = dirname(probe);
	return join(realpathSync(probe), relative(probe, absolute));
}

/**
 * Workspace confinement for agent-supplied paths: resolves `target` against `root` through realpath, so symlinks
 * cannot escape, and denies anything outside `root`. Run-directory names that nexo itself chooses use the lexical
 * `confine` in `@nexo/store`'s run-dir.ts instead.
 */
export function resolveConfined(root: string, target: string): string {
	const rootReal = realpathSync(root);
	const full = canonicalPath(target, rootReal);
	if (full !== rootReal && !full.startsWith(rootReal + sep)) {
		throw new NexoError({
			code: "TOOL_DENIED",
			message: `Path "${target}" is outside the workspace ${rootReal}`,
			hint: "Use a path inside the workspace",
			context: { target, workspace: rootReal },
		});
	}
	return full;
}
