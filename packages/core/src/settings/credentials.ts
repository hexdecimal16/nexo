import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, type Stats, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isPidAlive } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";

/** One provider's entry in `credentials.json`; fields other than `apiKey` are kept as they are. */
export interface CredentialEntry {
	apiKey?: string;
	[field: string]: unknown;
}

export type CredentialsData = Record<string, CredentialEntry>;

const OWNER_ONLY = 0o600;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(file: string, message: string, hint: string): NexoError {
	return new NexoError({ code: "CONFIG_INVALID", message: `${message}: ${file}`, hint, context: { file } });
}

function lstatOrNull(file: string): Stats | null {
	try {
		return lstatSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** A symlinked credentials file is refused: the atomic rename would replace the link and leave the old key in its target. */
function refuseSymlink(file: string, stat: Stats | null): void {
	if (stat?.isSymbolicLink()) {
		throw invalid(file, "Credentials file is a symbolic link", `Replace the symbolic link with a regular file (mode 600) at ${file}`);
	}
}

/**
 * Reads `credentials.json`. A missing file is empty. Refuses (CONFIG_INVALID) a symbolic link, a file that group or
 * others can access, and one that is not a JSON object of provider entries. `apiKey` values are returned trimmed.
 * Error messages never quote the file contents.
 */
export function readCredentials(file: string): CredentialsData {
	let text: string;
	try {
		const stat = lstatOrNull(file);
		if (!stat) return {};
		refuseSymlink(file, stat);
		if (process.platform !== "win32") {
			const mode = stat.mode & 0o777;
			if ((mode & 0o077) !== 0) {
				throw invalid(
					file,
					`Credentials file is accessible by group or others (mode ${mode.toString(8).padStart(4, "0")})`,
					`Run: chmod 600 ${file}`,
				);
			}
		}
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (error instanceof NexoError) throw error;
		throw new NexoError({
			code: "STORE_IO",
			message: `Cannot read credentials file ${file}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
			hint: "Check that the file exists and is readable by you",
			context: { file },
		});
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw invalid(file, "Credentials file is not valid JSON", `Fix the JSON syntax or remove the file (format: {"<provider>": {"apiKey": "..."}})`);
	}
	if (!isPlainObject(data)) throw invalid(file, "Credentials file must be a JSON object", `Use the format {"<provider>": {"apiKey": "..."}}`);
	const out: CredentialsData = {};
	for (const [provider, entry] of Object.entries(data)) {
		const apiKey = isPlainObject(entry) && typeof entry.apiKey === "string" ? entry.apiKey.trim() : null;
		if (!isPlainObject(entry) || (entry.apiKey !== undefined && !apiKey)) {
			throw invalid(file, `Credentials entry "${provider}" must be an object with a non-empty string apiKey`, `Fix or remove the "${provider}" entry`);
		}
		out[provider] = apiKey ? { ...entry, apiKey } : { ...entry };
	}
	return out;
}

/** Deletes `<file>.<pid>.<time>.tmp` files left by processes that are no longer running (they may hold keys). */
function removeStaleTemps(file: string): void {
	const prefix = `${basename(file)}.`;
	let names: string[];
	try {
		names = readdirSync(dirname(file));
	} catch {
		return;
	}
	for (const name of names) {
		const match = name.startsWith(prefix) ? /^(\d+)\.\d+\.tmp$/.exec(name.slice(prefix.length)) : null;
		if (!match) continue;
		const pid = Number(match[1]);
		if (pid === process.pid || !isPidAlive(pid)) rmSync(join(dirname(file), name), { force: true });
	}
}

/**
 * Writes `credentials.json` atomically (temp file with mode 0600, then rename) and re-applies mode 0600. Refuses a
 * symbolic link (CONFIG_INVALID) and first removes temp files left by crashed writers.
 */
export function writeCredentials(file: string, data: CredentialsData): void {
	refuseSymlink(file, lstatOrNull(file));
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		removeStaleTemps(file);
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: OWNER_ONLY, flag: "wx" });
		chmodSync(tmp, OWNER_ONLY);
		renameSync(tmp, file);
		chmodSync(file, OWNER_ONLY);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw new NexoError({
			code: "STORE_IO",
			message: `Cannot write credentials file ${file}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
			hint: `Check that ${dirname(file)} is writable by you`,
			context: { file },
		});
	}
}
