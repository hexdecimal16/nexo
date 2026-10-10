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

/** Returns a pure function that deep-copies a value with secrets replaced by `[REDACTED]`. */
export function createRedactor(extraPatterns: readonly string[] = []): Redactor {
	const patterns = [...BUILTIN_PATTERNS];
	for (const source of extraPatterns) {
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

	const redactString = (text: string): string => patterns.reduce((acc, re) => acc.replace(re, REDACTED), text);

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
