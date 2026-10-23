import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * The root of the working tree a directory belongs to, expressed in the same (non-resolved) path form as `cwd`, so it can be
 * prefix-matched against stored session cwds. Falls back to `cwd` itself outside a git repo or when git is unavailable.
 */
export function projectRoot(cwd: string): string {
	try {
		const top = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
		if (!top) return cwd;
		const rel = relative(realpathSync(top), realpathSync(cwd));
		if (rel.startsWith("..")) return cwd;
		let root = cwd;
		for (const segment of rel === "" ? [] : rel.split(sep)) {
			if (segment) root = dirname(root);
		}
		return root;
	} catch {
		return cwd;
	}
}

function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * The memory scope of the project `cwd` belongs to: `project:<12 hex>`, a hash of the repository's real main directory
 * (the parent of the shared `.git`), so every worktree and subfolder of one repo maps to the same scope. Outside a git
 * repo it hashes the real `cwd`.
 */
export function projectScope(cwd: string): string {
	let base = realOrSelf(cwd);
	try {
		const common = git(cwd, ["rev-parse", "--git-common-dir"]).trim();
		if (common) {
			const dir = realOrSelf(resolve(cwd, common));
			base = basename(dir) === ".git" ? dirname(dir) : dir;
		}
	} catch {
		// Not a git repo or git is unavailable: the directory itself identifies the project.
	}
	return `project:${createHash("sha256").update(base).digest("hex").slice(0, 12)}`;
}

/**
 * Every directory that counts as the same project as `cwd`: this working tree's root first, then the other worktrees of
 * the same repository (`git worktree list`), so sessions started in sibling worktrees belong to one project. Outside a git
 * repo it is just `[cwd]`.
 */
export function projectRoots(cwd: string): string[] {
	const root = projectRoot(cwd);
	const roots = [root];
	try {
		const seen = new Set([realOrSelf(root)]);
		for (const line of git(cwd, ["worktree", "list", "--porcelain"]).split("\n")) {
			if (!line.startsWith("worktree ")) continue;
			const path = line.slice("worktree ".length).trim();
			const real = realOrSelf(path);
			if (!path || seen.has(real)) continue;
			seen.add(real);
			roots.push(path);
		}
	} catch {
		// Not a git repo or git is unavailable: the single root stands.
	}
	return roots;
}
