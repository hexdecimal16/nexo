import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NexoError } from "@nexo/telemetry";
import type { CliIO, CliOptions } from "./common.ts";
import { nexoVersion } from "./version.ts";

const DEFAULT_PACKAGE = "@hexdecimal16/nexo";
const REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 10_000;

/** The published package name: read from the installed package.json, or the default when running from the repo. */
function packageName(): string {
	for (const relative of ["../../package.json", "../package.json"]) {
		try {
			const json = JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as { name?: unknown };
			if (typeof json.name === "string" && !json.name.startsWith("@nexo/")) return json.name;
		} catch {
			// not at this location; try the next one
		}
	}
	return DEFAULT_PACKAGE;
}

function parse(version: string): [number, number, number] | null {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a < b, 0 when equal, positive when a > b; null when either is not x.y.z. */
export function compareVersions(a: string, b: string): number | null {
	const pa = parse(a);
	const pb = parse(b);
	if (!pa || !pb) return null;
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] as number) - (pb[i] as number);
		if (d !== 0) return d;
	}
	return 0;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface UpdateOptions {
	/** Replaces the global fetch; tests pass a fake. */
	fetch?: FetchLike;
	/** Replaces the installed version and package name; tests pass fixed values. */
	current?: string;
	name?: string;
}

/**
 * `nexo update`: compares the installed version with the registry's `latest` dist-tag and prints the command to
 * update. It never installs anything. Exit 0 when up to date or when an update is available, 1 when the registry
 * cannot be reached.
 */
export async function updateCommand(io: CliIO, options: CliOptions & UpdateOptions = {}): Promise<number> {
	const name = options.name ?? packageName();
	const current = options.current ?? nexoVersion();
	const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
	let latest: string;
	try {
		const response = await doFetch(`${REGISTRY}/${name.replace("/", "%2f")}/latest`, { signal });
		if (!response.ok) throw new Error(`the registry answered HTTP ${response.status}`);
		const body = (await response.json()) as { version?: unknown };
		if (typeof body.version !== "string") throw new Error("the registry reply has no version");
		latest = body.version;
	} catch (cause) {
		throw new NexoError({
			code: "PROVIDER_UNAVAILABLE",
			message: `Could not check ${name} on npm: ${(cause as Error).message}`,
			hint: `Check your connection, or run: npm view ${name} version`,
			cause,
		});
	}
	const order = compareVersions(current, latest);
	if (order === null) {
		io.stdout.write(`Installed: ${current}, latest: ${latest}\nRun: npm install -g ${name}@latest\n`);
	} else if (order >= 0) {
		io.stdout.write(`nexo ${current} is up to date (latest on npm: ${latest}).\n`);
	} else {
		io.stdout.write(`Update available: ${current} -> ${latest}\nRun: npm install -g ${name}@latest\n`);
	}
	return 0;
}
