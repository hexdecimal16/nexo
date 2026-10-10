import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { NexoError } from "@nexo/telemetry";

function isMissing(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Absolute form of `target` (relative to `base`) with its deepest existing ancestor resolved through realpath.
 * Ancestors are probed with lstat so a dangling symlink is found rather than walked past; a symlink whose target
 * cannot be resolved is denied with TOOL_DENIED.
 */
export function canonicalPath(target: string, base: string = process.cwd()): string {
	const absolute = isAbsolute(target) ? resolve(target) : resolve(base, target);
	let probe = absolute;
	for (;;) {
		try {
			lstatSync(probe);
			break;
		} catch (err) {
			if (!isMissing(err)) throw err;
			const parent = dirname(probe);
			if (parent === probe) break;
			probe = parent;
		}
	}
	let resolvedProbe: string;
	try {
		resolvedProbe = realpathSync(probe);
	} catch (cause) {
		if (!isMissing(cause)) throw cause;
		throw new NexoError({
			code: "TOOL_DENIED",
			message: `Path "${target}" passes through a symlink that cannot be resolved: ${probe}`,
			hint: "Use a path that does not go through dangling symlinks",
			context: { target, link: probe },
			cause,
		});
	}
	return join(resolvedProbe, relative(probe, absolute));
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
