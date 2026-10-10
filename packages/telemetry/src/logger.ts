import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { toErrorPayload } from "./errors.ts";
import type { Redactor } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
	dir: string;
	component: string;
	redact: Redactor;
	level?: LogLevel;
	now?: () => Date;
	fields?: Record<string, unknown>;
}

export interface Logger {
	debug(msg: string, fields?: Record<string, unknown>): void;
	info(msg: string, fields?: Record<string, unknown>): void;
	warn(msg: string, fields?: Record<string, unknown>): void;
	error(msg: string, fields?: Record<string, unknown>): void;
	child(fields: Record<string, unknown>): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function normalizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!fields) return {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) out[key] = value instanceof Error ? toErrorPayload(value) : value;
	return out;
}

/** JSON-lines logger writing to `<dir>/nexo-YYYY-MM-DD.log` (UTC date). */
export function createLogger(options: LoggerOptions): Logger {
	mkdirSync(options.dir, { recursive: true });
	const now = options.now ?? (() => new Date());
	const minLevel = ORDER[options.level ?? "info"];

	const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
		if (ORDER[level] < minLevel) return;
		const ts = now().toISOString();
		const record = options.redact({
			ts,
			level,
			msg,
			component: options.component,
			...normalizeFields(options.fields),
			...normalizeFields(fields),
		});
		appendFileSync(join(options.dir, `nexo-${ts.slice(0, 10)}.log`), `${JSON.stringify(record)}\n`);
	};

	return {
		debug: (msg, fields) => write("debug", msg, fields),
		info: (msg, fields) => write("info", msg, fields),
		warn: (msg, fields) => write("warn", msg, fields),
		error: (msg, fields) => write("error", msg, fields),
		child: (fields) => createLogger({ ...options, fields: { ...options.fields, ...fields } }),
	};
}
