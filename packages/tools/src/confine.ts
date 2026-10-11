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
 * cannot be resolved is denied with TOOL_DENIED. `realpath` resolves the existing ancestor.
 */
export function canonicalPath(target: string, base: string = process.cwd(), realpath: (path: string) => string = realpathSync): string {
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
		resolvedProbe = realpath(probe);
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

function isWithin(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir + sep);
}

/**
 * Guards the nexo home (config, credentials, skills, runs) against the agent's file tools, whatever the workspace.
 * Paths are compared through the native realpath, which also settles letter case on case-insensitive file systems.
 * A workspace that lies inside the nexo home (a run's own workspace) stays writable.
 */
export function nexoHomeGuard(nexoHome: string, workspaceRoot: string): { checkWrite(path: string): void; checkRead(path: string): void } {
	const native = realpathSync.native;
	const home = canonicalPath(nexoHome, process.cwd(), native);
	const workspace = canonicalPath(workspaceRoot, process.cwd(), native);
	const credentials = join(home, "credentials.json");
	const exempt = isWithin(workspace, home) && workspace !== home ? workspace : null;
	const deny = (target: string, message: string) =>
		new NexoError({
			code: "TOOL_DENIED",
			message,
			hint: "nexo's own files (config, credentials, skills, runs) are not changed by the agent; edit them yourself outside the run",
			context: { target, nexoHome: home },
		});
	return {
		checkWrite(path) {
			const full = canonicalPath(path, workspace, native);
			if (isWithin(full, home) && !(exempt !== null && isWithin(full, exempt))) throw deny(path, `Path "${path}" is inside the nexo home ${home}`);
		},
		checkRead(path) {
			if (canonicalPath(path, workspace, native) === credentials) throw deny(path, `Path "${path}" is the nexo credentials file`);
		},
	};
}
