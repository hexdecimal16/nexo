import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { NexoPaths } from "@nexo/store";
import { toErrorPayload } from "@nexo/telemetry";
import type { Settings } from "./settings.ts";

/** Oldest Node release nexo supports; keep in step with `engines.node` in package.json. */
export const MIN_NODE_VERSION = "22.19.0";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	id: string;
	status: DoctorStatus;
	message: string;
	/** One-line fix; present for `warn` and `fail`. */
	fix?: string;
}

export interface DoctorReport {
	/** True when no check failed (warnings do not count). */
	ok: boolean;
	checks: DoctorCheck[];
}

export interface DoctorOptions {
	paths: NexoPaths;
	settings: Settings;
	env: NodeJS.ProcessEnv;
	cwd: string;
	/** Defaults to `process.version`; tests pass a fixed value. */
	nodeVersion?: string;
}

function parseVersion(version: string): [number, number, number] | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionAtLeast(version: string, minimum: string): boolean {
	const a = parseVersion(version);
	const b = parseVersion(minimum);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
	}
	return true;
}

/** True when `dir`, or its nearest existing parent, can be written to. Never creates anything. */
function writable(dir: string): boolean {
	let current = dir;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
	try {
		accessSync(current, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Looks the command up on PATH (or as a path) without running it. */
function commandExists(command: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
	if (isAbsolute(command) || command.includes("/")) return existsSync(resolve(cwd, command));
	return (env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, command)));
}

/**
 * Read-only health checks for a nexo setup: Node version, config, model roles, provider keys, home directory and the
 * optional judge, embedding and MCP parts. Never throws, never prints key values, never creates files or starts servers.
 */
export function runDoctor(options: DoctorOptions): DoctorReport {
	const { paths, settings, env, cwd } = options;
	const checks: DoctorCheck[] = [];
	const add = (check: DoctorCheck): void => {
		checks.push(check);
	};

	const nodeVersion = options.nodeVersion ?? process.version;
	add(
		versionAtLeast(nodeVersion, MIN_NODE_VERSION)
			? { id: "node", status: "ok", message: `Node ${nodeVersion}` }
			: { id: "node", status: "fail", message: `Node ${nodeVersion} is older than ${MIN_NODE_VERSION}`, fix: `Install Node ${MIN_NODE_VERSION} or newer (an LTS release is recommended)` },
	);

	add(
		writable(paths.home)
			? { id: "home", status: "ok", message: `Data directory ${paths.home} is writable` }
			: { id: "home", status: "fail", message: `Data directory ${paths.home} is not writable`, fix: "Fix its permissions, or set NEXO_HOME to a directory you can write to" },
	);

	let config: ReturnType<Settings["loadConfig"]>["config"] | null = null;
	try {
		config = settings.loadConfig().config;
		add({ id: "config", status: "ok", message: "Configuration is valid" });
	} catch (error) {
		const payload = toErrorPayload(error);
		const hint = (payload as { hint?: string }).hint;
		add({ id: "config", status: "fail", message: payload.message.split("\n").join(" ").trim(), fix: hint ?? `Fix the config file ${paths.config}` });
	}

	const setup = settings.setupStatus();
	if (setup.error) {
		add({ id: "models", status: "fail", message: setup.error.message, fix: "Fix the config or credentials file named above" });
	} else if (setup.needed) {
		add({ id: "models", status: "fail", message: `Models not set: ${setup.missingModels.join(", ")}`, fix: "Run `nexo` to open setup, or `nexo settings set models.s1 <provider/id>` and the same for s2" });
	} else {
		add({ id: "models", status: "ok", message: "Models s1 and s2 are set" });
	}

	for (const key of settings.keyProviders()) {
		if (key.state === "unset") {
			add({ id: `key:${key.provider}`, status: "warn", message: `No API key for ${key.provider}`, fix: `Run \`nexo settings set-key ${key.provider}\` (not needed for keyless or local providers)` });
		} else {
			add({ id: `key:${key.provider}`, status: "ok", message: `API key for ${key.provider} found (${key.state === "env" ? "environment" : "credentials file"})` });
		}
	}

	if (config) {
		add(
			(config.models.judge ?? []).length > 0
				? { id: "judge", status: "ok", message: "Judge model is set" }
				: { id: "judge", status: "warn", message: "No judge model set (LLM-judge scoring is off)", fix: "Run `nexo settings set models.judge <provider/id>` to enable it" },
		);
		add(
			config.models.embedding
				? { id: "embedding", status: "ok", message: "Embedding model is set" }
				: { id: "embedding", status: "warn", message: "No embedding model set (memory search is limited)", fix: "Run `nexo settings set models.embedding <provider/id>` to enable it" },
		);
		for (const [name, server] of Object.entries(config.mcp.servers)) {
			add(
				commandExists(server.command, env, cwd)
					? { id: `mcp:${name}`, status: "ok", message: `MCP server ${name}: command ${server.command} found` }
					: { id: `mcp:${name}`, status: "warn", message: `MCP server ${name}: command ${server.command} not found`, fix: `Install ${server.command} or fix mcp.servers.${name}.command in ${paths.config}` },
			);
		}
	}

	return { ok: checks.every((c) => c.status !== "fail"), checks };
}
