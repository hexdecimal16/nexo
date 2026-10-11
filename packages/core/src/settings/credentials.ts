import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

/**
 * Reads `credentials.json`. A missing file is empty. Refuses (CONFIG_INVALID) a file that group or others can access,
 * and one that is not a JSON object of provider entries. Error messages never quote the file contents.
 */
export function readCredentials(file: string): CredentialsData {
	if (!existsSync(file)) return {};
	let text: string;
	try {
		if (process.platform !== "win32") {
			const mode = statSync(file).mode & 0o777;
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
	for (const [provider, entry] of Object.entries(data)) {
		if (!isPlainObject(entry) || (entry.apiKey !== undefined && (typeof entry.apiKey !== "string" || entry.apiKey === ""))) {
			throw invalid(file, `Credentials entry "${provider}" must be an object with a non-empty string apiKey`, `Fix or remove the "${provider}" entry`);
		}
	}
	return data as CredentialsData;
}

/** Writes `credentials.json` atomically (temp file with mode 0600, then rename) and re-applies mode 0600. */
export function writeCredentials(file: string, data: CredentialsData): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
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
