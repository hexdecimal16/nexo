import { judgeFamilyWarnings, judgeKey, loadConfig, type NexoConfig } from "@nexo/core";
import { ensureNexoDirs, isPidAlive, openDb, recoverCrashedRuns, resolveNexoPaths } from "@nexo/store";
import { createRedactor, NexoError } from "@nexo/telemetry";
import { type ReadOnlyInfo, startWebServer } from "@nexo/web";

export const DEFAULT_UI_PORT = 4317;

export interface UiIO {
	stdout: { write(text: string): boolean };
	stderr: { write(text: string): boolean };
}

/** `--port`: an integer from 0 (any free port) to 65535; undefined keeps `fallback`. */
export function parsePort(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new NexoError({ code: "CONFIG_INVALID", message: "--port must be an integer from 0 to 65535", context: { port: value } });
	}
	return port;
}

/** `ui.port` from the config: absent means DEFAULT_UI_PORT, anything but an integer from 1 to 65535 is CONFIG_INVALID. */
export function configUiPort(value: unknown): number {
	if (value === undefined) return DEFAULT_UI_PORT;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: "ui.port must be an integer from 1 to 65535",
			hint: "Fix ui.port in your nexo config, or pass --port",
			context: { port: value ?? null },
		});
	}
	return value;
}

/**
 * Runs the web UI until `signal` aborts. Runs left `running` by a crashed process are marked aborted first (spec §12).
 * Without a loadable config the UI still starts, but read-only: the API refuses verdicts with CONFIG_INVALID, because
 * comments must not be stored without the user's redaction patterns.
 */
export async function runUi(options: { env: NodeJS.ProcessEnv; cwd: string; port?: string; io: UiIO; signal?: AbortSignal }): Promise<number> {
	const flagPort = options.port === undefined ? undefined : parsePort(options.port, DEFAULT_UI_PORT);
	const paths = resolveNexoPaths(options.env);
	ensureNexoDirs(paths);
	let config: NexoConfig | null = null;
	let readOnly: ReadOnlyInfo | null = null;
	try {
		config = loadConfig({ paths, cwd: options.cwd }).config;
	} catch (error) {
		if (!(error instanceof NexoError) || error.code !== "CONFIG_INVALID") throw error;
		readOnly = { message: "the nexo config is missing or invalid", hint: error.hint ?? `Fix ${paths.config}, then restart nexo ui` };
		options.io.stderr.write("warning: nexo config is missing or invalid; the UI is read-only (verdicts are disabled) until it is fixed\n");
	}
	const port = flagPort ?? (config ? configUiPort((config.ui as { port?: unknown } | undefined)?.port) : DEFAULT_UI_PORT);
	const patterns = config ? config.redaction.patterns : [];
	const db = openDb(paths.db);
	const recovered = recoverCrashedRuns(db, isPidAlive, new Date().toISOString());
	if (recovered.length > 0) options.io.stderr.write(`Marked ${recovered.length} run(s) left by a crashed process as aborted\n`);
	let server: Awaited<ReturnType<typeof startWebServer>>;
	try {
		const judge = config ? { key: judgeKey(config), warnings: judgeFamilyWarnings(config) } : undefined;
		server = await startWebServer({ db, redact: createRedactor(patterns), port, readOnly, judge });
	} catch (error) {
		db.close();
		throw error;
	}
	options.io.stdout.write(`nexo UI: ${server.url}?token=${server.token}\nPress Ctrl-C to stop.\n`);
	await new Promise<void>((resolve) => {
		if (!options.signal || options.signal.aborted) return resolve();
		options.signal.addEventListener("abort", () => resolve(), { once: true });
	});
	await server.close();
	db.close();
	options.io.stderr.write("nexo UI stopped\n");
	return 0;
}
