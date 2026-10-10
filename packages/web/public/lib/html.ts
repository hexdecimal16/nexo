// Escaping HTML builder. Every interpolated value is escaped unless it is itself a SafeHtml produced by `html`,
// so agent-produced text (instructions, outputs, tool results, file names) can never become markup.

export class SafeHtml {
	readonly value: string;

	constructor(value: string) {
		this.value = value;
	}

	toString(): string {
		return this.value;
	}
}

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
	"`": "&#96;",
};

/** Escapes text for use in element content and in quoted attribute values. */
export function esc(value: unknown): string {
	return String(value ?? "").replace(/[&<>"'`]/g, (c) => ESCAPES[c] ?? c);
}

function part(value: unknown): string {
	if (value instanceof SafeHtml) return value.value;
	if (Array.isArray(value)) return value.map(part).join("");
	if (value === null || value === undefined || value === false) return "";
	return esc(value);
}

/** Tagged template: `html\`<td>${text}</td>\``. Arrays are concatenated; null, undefined and false render nothing. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
	let out = strings[0] ?? "";
	for (let i = 0; i < values.length; i++) out += part(values[i]) + (strings[i + 1] ?? "");
	return new SafeHtml(out);
}

/** Pretty JSON for display inside <pre>; the caller still interpolates it through `html`. */
export function prettyJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
