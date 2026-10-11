import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createSettings, keyStatusLabel, type Settings, type SettingView } from "@nexo/core";
import { ensureNexoDirs, resolveNexoPaths } from "@nexo/store";
import { NexoError, toErrorPayload } from "@nexo/telemetry";
import { type CliIO, type CliOptions, type CliStdio, EXIT_SIGINT, exitCodeFor, printError, usageError } from "./common.ts";
import { openLogger } from "./runtime.ts";

const MAX_PIPED_KEY_BYTES = 64 * 1024;

/** One line from a piped stdin; the key never passes through argv. Resolves null when `signal` aborts or stdin fails first. */
function readPipedKey(stdin: CliStdio["stdin"], signal: AbortSignal | undefined): Promise<string | null> {
	return new Promise((resolve) => {
		let text = "";
		let settled = false;
		const finish = (result: string | null): void => {
			if (settled) return;
			settled = true;
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			stdin.off("error", onError);
			signal?.removeEventListener("abort", onAbort);
			stdin.pause();
			resolve(result);
		};
		const line = (): string => (text.split(/\r?\n/, 1)[0] ?? "").trim();
		const onData = (chunk: Buffer | string): void => {
			text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (text.includes("\n") || text.length > MAX_PIPED_KEY_BYTES) finish(line());
		};
		const onEnd = (): void => finish(line());
		const onError = (): void => finish(null);
		const onAbort = (): void => finish(null);
		if (signal?.aborted) return resolve(null);
		stdin.on("data", onData);
		stdin.on("end", onEnd);
		stdin.on("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
		stdin.resume();
	});
}

/**
 * Reads a line from the terminal in raw mode, so nothing is echoed. Resolves null on Ctrl-C, Ctrl-D at an empty
 * prompt, end of input, an input error or an abort; raw mode is always switched off again.
 */
function readHiddenKey(stdin: CliStdio["stdin"], stderr: CliIO["stderr"], provider: string, signal: AbortSignal | undefined): Promise<string | null> {
	return new Promise((resolve) => {
		let value = "";
		let settled = false;
		const finish = (result: string | null): void => {
			if (settled) return;
			settled = true;
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			stdin.off("error", onEnd);
			signal?.removeEventListener("abort", onEnd);
			stdin.setRawMode?.(false);
			stdin.pause();
			stderr.write("\n");
			resolve(result);
		};
		const onEnd = (): void => finish(null);
		const onData = (chunk: Buffer | string): void => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			for (let i = 0; i < text.length; i++) {
				const ch = text[i] as string;
				if (ch === "\r" || ch === "\n") return finish(value);
				if (ch === "\x03" || (ch === "\x04" && value === "")) return finish(null);
				if (ch === "\x7f" || ch === "\b") value = value.slice(0, -1);
				else if (ch === "\x1b") i = text.length; // an escape sequence (arrow keys): ignore the rest of the chunk
				else if (ch >= " ") value += ch;
			}
		};
		if (signal?.aborted) return resolve(null);
		stderr.write(`API key for ${provider} (input hidden): `);
		stdin.setRawMode?.(true);
		stdin.on("data", onData);
		stdin.on("end", onEnd);
		stdin.on("error", onEnd);
		signal?.addEventListener("abort", onEnd, { once: true });
		stdin.resume();
	});
}

function show(view: SettingView): string {
	return view.value === null ? "unset" : String(view.value);
}

/** `nexo settings get|set|set-key`: no TUI, for scripts. Invalid keys and values are usage errors (exit 2). */
export async function settingsCommand(args: string[], io: CliIO, options: CliOptions, stdio: CliStdio): Promise<number> {
	const [sub, ...rest] = args;
	const env = options.env ?? process.env;
	const paths = resolveNexoPaths(env);
	ensureNexoDirs(paths);
	const build = (): Settings => {
		const settings = createSettings({ paths, cwd: options.cwd ?? process.cwd(), env, models: options.models ?? builtinModels() });
		openLogger(settings, paths, "settings");
		return settings;
	};
	let redact: (text: string) => string = (text) => text;
	try {
		switch (sub) {
			case "get": {
				if (rest.length !== 1) throw usageError("nexo settings get needs exactly one key");
				const view = build().getSetting(rest[0] as string);
				io.stdout.write(`${show(view)}\n`);
				if (view.notice) io.stderr.write(`note: ${view.notice}\n`);
				return 0;
			}
			case "set": {
				if (rest.length !== 2) throw usageError("nexo settings set needs a key and a value");
				const view = build().setSettingFromString(rest[0] as string, rest[1] as string);
				io.stdout.write(`${view.key} = ${show(view)}\n`);
				if (view.notice) io.stderr.write(`note: ${view.notice}\n`);
				return 0;
			}
			case "set-key": {
				if (rest.length > 1) {
					throw new NexoError({
						code: "CONFIG_INVALID",
						message: "nexo settings set-key takes only the provider; a key on the command line would leak into shell history and process lists",
						hint: "Run `nexo settings set-key <provider>` and type the key at the prompt, or pipe it on stdin: `printf %s \"$KEY\" | nexo settings set-key <provider>`",
					});
				}
				if (rest.length === 0) throw usageError("nexo settings set-key needs a provider");
				const settings = build();
				redact = settings.redact;
				const provider = rest[0] as string;
				// Checked before the prompt, so a mistyped (or secret-looking) provider is never echoed or asked about.
				settings.validateKeyProvider(provider);
				const key = stdio.stdin.isTTY === true ? await readHiddenKey(stdio.stdin, io.stderr, provider, options.signal) : await readPipedKey(stdio.stdin, options.signal);
				if (key === null) {
					io.stderr.write("cancelled\n");
					return EXIT_SIGINT;
				}
				if (key === "") throw new NexoError({ code: "INVALID_REQUEST", message: "No key received", hint: "Type or pipe the API key; an empty line is not a key" });
				const status = settings.setKey(provider, key);
				io.stdout.write(`${status.provider}: ${keyStatusLabel(status)}\n`);
				return 0;
			}
			default:
				throw usageError(sub === undefined ? "nexo settings needs get, set or set-key (or a terminal for the screen)" : `Unknown settings command "${sub}"`);
		}
	} catch (error) {
		const payload = toErrorPayload(error);
		printError(io, payload, redact);
		return payload.code === "INVALID_REQUEST" ? 2 : exitCodeFor(payload.code);
	}
}
