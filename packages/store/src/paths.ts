import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface NexoPaths {
	home: string;
	db: string;
	runs: string;
	sessions: string;
	optim: string;
	logs: string;
	skills: string;
	config: string;
	credentials: string;
	wikis: string;
}

export function resolveNexoPaths(env: NodeJS.ProcessEnv = process.env): NexoPaths {
	const home = env.NEXO_HOME ? resolve(env.NEXO_HOME) : join(homedir(), ".nexo");
	return {
		home,
		db: join(home, "nexo.db"),
		runs: join(home, "runs"),
		sessions: join(home, "sessions"),
		optim: join(home, "optim"),
		logs: join(home, "logs"),
		skills: join(home, "skills"),
		config: join(home, "config.json"),
		credentials: join(home, "credentials.json"),
		wikis: join(home, "wikis"),
	};
}

export function ensureNexoDirs(paths: NexoPaths): void {
	for (const dir of [paths.home, paths.runs, paths.sessions, paths.optim, paths.logs, paths.skills, paths.wikis]) mkdirSync(dir, { recursive: true });
}
