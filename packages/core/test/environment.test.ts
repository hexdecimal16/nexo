import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { environmentBlock, gitBranch, localTime } from "../src/engine/environment.ts";
import { DEFAULT_SYSTEM_PROMPT, renderSystemPrompt } from "../src/engine/prompts.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "nexo-env-"));
	dirs.push(dir);
	return dir;
}

describe("environmentBlock", () => {
	it("names the launch directory, branch, platform, shell and time for a git repo", () => {
		const dir = tempDir();
		execFileSync("git", ["init", "-q", "-b", "feature/env"], { cwd: dir });
		const text = environmentBlock({ projectDir: dir, now: new Date(2026, 0, 5, 9, 7), shell: "/bin/zsh" });
		expect(text).toContain(`- Launch directory: ${dir}`);
		expect(text).toContain("- Git repository: true");
		expect(text).toContain("- Git branch: feature/env");
		expect(text).toContain("- Shell: /bin/zsh");
		expect(text).toContain("- Current local time: 2026-01-05 09:07");
		expect(text).toContain("workspace is a scratch copy");
	});

	it("omits the branch outside a git repo", () => {
		const dir = tempDir();
		expect(gitBranch(dir)).toBeNull();
		const text = environmentBlock({ projectDir: dir, now: new Date() });
		expect(text).toContain("- Git repository: false");
		expect(text).not.toContain("Git branch");
	});

	it("leaves out launch directory and git lines without projectDir", () => {
		const text = environmentBlock({ now: new Date() });
		expect(text).not.toContain("Launch directory");
		expect(text).not.toContain("Git repository");
		expect(text).toContain("- Current local time:");
	});

	it("does not call a shared workspace a scratch copy", () => {
		const dir = tempDir();
		const text = environmentBlock({ projectDir: dir, now: new Date(), workspaceShared: true });
		expect(text).toContain("shared directory that runs edit in place");
		expect(text).not.toContain("scratch copy");
	});

	it("formats local time with a UTC offset", () => {
		expect(localTime(new Date(2026, 5, 1, 14, 30))).toMatch(/^2026-06-01 14:30 .+ \(UTC[+-]\d{2}:\d{2}\)$/);
	});

	it("renders last, after memories, and adds nothing when absent", () => {
		const base = { systemPrompt: DEFAULT_SYSTEM_PROMPT, plannerPrompt: null, workspace: "/w", skillIndex: "SKILLS", memories: "MEMORIES" };
		const text = renderSystemPrompt({ ...base, environment: "ENVIRONMENT" });
		expect(text.indexOf("ENVIRONMENT")).toBeGreaterThan(text.indexOf("MEMORIES"));
		expect(renderSystemPrompt({ ...base, environment: "" })).toBe(renderSystemPrompt(base));
	});
});
