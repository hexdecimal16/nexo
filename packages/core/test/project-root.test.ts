import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectRoot, projectRoots, projectScope } from "../src/session/project-root.ts";

const dirs: string[] = [];
const temp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "nexo-root-"));
	dirs.push(dir);
	return dir;
};

describe("projectRoot", () => {
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("returns the git root, in the caller's path form, from a nested directory", () => {
		const repo = temp();
		execFileSync("git", ["init", "-q"], { cwd: repo });
		const nested = join(repo, "packages", "x");
		mkdirSync(nested, { recursive: true });
		expect(projectRoot(nested)).toBe(repo);
		expect(projectRoot(repo)).toBe(repo);
		// A symlinked form of the same directory (macOS /var -> /private/var) still maps back to the given form.
		const real = realpathSync(nested);
		expect(realpathSync(projectRoot(real))).toBe(realpathSync(repo));
	});

	it("falls back to the directory itself outside a git repo", () => {
		const plain = temp();
		expect(projectRoot(plain)).toBe(plain);
		expect(projectRoots(plain)).toEqual([plain]);
	});

	it("projectRoots lists this worktree first, then the repository's other worktrees", () => {
		const repo = temp();
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-qm", "init"], { cwd: repo });
		const worktree = join(temp(), "wt");
		execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "feature"], { cwd: repo });
		const nested = join(worktree, "src");
		mkdirSync(nested);

		const fromWorktree = projectRoots(nested);
		expect(realpathSync(fromWorktree[0] as string)).toBe(realpathSync(worktree));
		expect(fromWorktree.map((p) => realpathSync(p)).sort()).toEqual([realpathSync(repo), realpathSync(worktree)].sort());

		const fromMain = projectRoots(repo);
		expect(realpathSync(fromMain[0] as string)).toBe(realpathSync(repo));
		expect(fromMain).toHaveLength(2);

		// One scope for the repo, whichever worktree or subfolder it is asked from.
		expect(projectScope(nested)).toBe(projectScope(repo));
		expect(projectScope(worktree)).toBe(projectScope(repo));
		expect(projectScope(repo)).toMatch(/^project:[0-9a-f]{12}$/);
		expect(projectScope(temp())).not.toBe(projectScope(repo));
	});
});
