import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitProjectRoot } from "../src/session/project-root.ts";

describe("gitProjectRoot", () => {
	it("is the repository root for a folder in a git work tree and null outside one", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "nexo-gpr-")));
		expect(gitProjectRoot(dir)).toBeNull();
		execFileSync("git", ["init", "-q", dir]);
		mkdirSync(join(dir, "src"));
		expect(gitProjectRoot(join(dir, "src"))).toBe(dir);
	});
});
