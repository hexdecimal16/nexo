import { execFileSync } from "node:child_process";
import { release, type } from "node:os";

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

/** The current branch, or `detached at <sha>` on a detached HEAD; null outside a git repo. */
export function gitBranch(cwd: string): string | null {
	if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
	const branch = git(cwd, ["branch", "--show-current"]);
	if (branch) return branch;
	const sha = git(cwd, ["rev-parse", "--short", "HEAD"]);
	return sha ? `detached at ${sha}` : "unknown";
}

/** Local time as `YYYY-MM-DD HH:mm <zone> (UTC±hh:mm)`. */
export function localTime(now: Date): string {
	const pad = (n: number): string => String(Math.abs(n)).padStart(2, "0");
	const offset = -now.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} ${zone} (UTC${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)})`;
}

export interface EnvironmentInput {
	/** Directory nexo was launched from; absent when the caller did not pass one. */
	projectDir?: string;
	now: Date;
	shell?: string;
	/** True when the run edits a shared directory in place (`workspace` option) instead of its own scratch copy. */
	workspaceShared?: boolean;
}

/** The prompt's environment section: where nexo was launched, git state, platform, shell and the current local time. */
export function environmentBlock(input: EnvironmentInput): string {
	const lines = ["Environment:"];
	if (input.projectDir) {
		const branch = gitBranch(input.projectDir);
		lines.push(`- Launch directory: ${input.projectDir}`);
		lines.push(`- Git repository: ${branch !== null}`);
		if (branch !== null) lines.push(`- Git branch: ${branch}`);
		lines.push(
			input.workspaceShared
				? "- The workspace is a shared directory that runs edit in place."
				: "- The user's project files live in the launch directory. The workspace is a scratch copy for files you create; edit project files by absolute path in the launch directory.",
		);
	}
	lines.push(`- Platform: ${process.platform} (${type()} ${release()})`);
	if (input.shell) lines.push(`- Shell: ${input.shell}`);
	lines.push(`- Current local time: ${localTime(input.now)}`);
	return lines.join("\n");
}
