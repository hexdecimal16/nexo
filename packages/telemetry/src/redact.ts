import { NexoError } from "./errors.ts";

export const REDACTED = "[REDACTED]";

const BUILTIN_PATTERNS: readonly RegExp[] = [
	/sk-ant-[A-Za-z0-9_-]{16,}/g,
	/sk-[A-Za-z0-9_-]{16,}/g,
	/AIza[0-9A-Za-z_-]{35}/g,
	/gh[pousr]_[A-Za-z0-9]{36,}/g,
	/xox[abprs]-[A-Za-z0-9-]{10,}/g,
	/AKIA[0-9A-Z]{16}/g,
	/Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

const SENSITIVE_KEY = /^(api[_-]?key|authorization|password|secret|token|access[_-]?token|refresh[_-]?token|x-api-key)$/i;

export type Redactor = <T>(value: T) => T;

/** Exact secret values (such as stored API keys) that every redactor built with this set replaces, including values added later. */
export interface SecretSet {
	/** Adds a value; empty strings are ignored. */
	add(value: string): void;
	has(value: string): boolean;
	readonly size: number;
	/** The values, longest first. */
	values(): readonly string[];
}

export function createSecretSet(initial: Iterable<string> = []): SecretSet {
	const set = new Set<string>();
	let sorted: string[] = [];
	const add = (value: string): void => {
		if (value === "" || set.has(value)) return;
		set.add(value);
		sorted = [...set].sort((a, b) => b.length - a.length);
	};
	for (const value of initial) add(value);
	return {
		add,
		has: (value) => set.has(value),
		get size() {
			return set.size;
		},
		values: () => sorted,
	};
}

export interface RedactorOptions {
	/** Exact values to replace, read on every call so secrets added later apply immediately. */
	secrets?: SecretSet;
}

/** A redactor whose implementation can be swapped, so holders of the reference (the logger) pick up a rebuilt redactor. */
export interface MutableRedactor {
	<T>(value: T): T;
	replace(next: Redactor): void;
}

export function createMutableRedactor(initial: Redactor): MutableRedactor {
	let current = initial;
	const redact = (<T>(value: T): T => current(value)) as MutableRedactor;
	redact.replace = (next) => {
		current = next;
	};
	return redact;
}

/** Returns a pure function that deep-copies a value with secrets replaced by `[REDACTED]`. */
export function createRedactor(extraPatterns: readonly string[] = [], options: RedactorOptions = {}): Redactor {
	const patterns = [...BUILTIN_PATTERNS];
	for (const source of extraPatterns) {
		if (source === "") {
			throw new NexoError({
				code: "CONFIG_INVALID",
				message: "Empty redaction pattern",
				hint: "Remove empty strings from redaction.patterns in your nexo config",
			});
		}
		try {
			patterns.push(new RegExp(source, "g"));
		} catch (cause) {
			throw new NexoError({
				code: "CONFIG_INVALID",
				message: `Invalid redaction pattern: ${source}`,
				hint: "Fix redaction.patterns in your nexo config",
				context: { pattern: source },
				cause,
			});
		}
	}

	const secrets = options.secrets;
	const redactString = (text: string): string => {
		let out = text;
		if (secrets) for (const secret of secrets.values()) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
		return patterns.reduce((acc, re) => acc.replace(re, REDACTED), out);
	};

	/** `ancestors` holds only the objects on the current path, so shared non-circular references are copied, not marked. */
	const walk = (value: unknown, ancestors: object[]): unknown => {
		if (typeof value === "string") return redactString(value);
		if (value === null || typeof value !== "object") return value;
		if (ancestors.includes(value)) return "[Circular]";
		ancestors.push(value);
		try {
			if (Array.isArray(value)) return value.map((item) => walk(item, ancestors));
			const out: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(value)) {
				out[key] = SENSITIVE_KEY.test(key) && item !== null && item !== undefined ? REDACTED : walk(item, ancestors);
			}
			return out;
		} finally {
			ancestors.pop();
		}
	};

	return <T>(value: T): T => walk(value, []) as T;
}
