/** Blocks dropped with their content: they never hold readable page text. */
const DROP_BLOCKS = ["script", "style", "noscript", "svg", "iframe", "template", "head", "nav", "footer"];
const DROP_RE = new RegExp(`<(${DROP_BLOCKS.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi");

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "\u2014",
	ndash: "\u2013",
	hellip: "\u2026",
	lsquo: "\u2018",
	rsquo: "\u2019",
	ldquo: "\u201c",
	rdquo: "\u201d",
};

function decodeEntities(text: string): string {
	return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
		if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
		const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
		if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return whole;
		try {
			return String.fromCodePoint(code);
		} catch {
			return whole;
		}
	});
}

/** True when the text looks like an HTML document, for responses that carry no content type. */
export function looksLikeHtml(text: string): boolean {
	return /^\s*(<!doctype html|<html[\s>])/i.test(text);
}

/**
 * Readable plain text from an HTML page: scripts, styles, navigation and footers are dropped, headings and list items
 * keep a light markdown shape, and links stay as `[text](url)` so an agent can follow them.
 */
export function htmlToText(html: string): string {
	let out = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROP_RE, "");
	out = out.replace(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, dq: string | undefined, sq: string | undefined, inner: string) => {
		const href = (dq ?? sq ?? "").trim();
		const label = inner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
		if (!label) return "";
		if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return label;
		return `[${label}](${href})`;
	});
	out = out
		.replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `)
		.replace(/<\/h[1-6]\s*>/gi, "\n\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/?(?:p|div|section|article|main|header|aside|ul|ol|table|tr|blockquote|pre|figure|figcaption|dl|dt|dd)\b[^>]*>/gi, "\n")
		.replace(/<\/?(?:td|th)\b[^>]*>/gi, " ")
		.replace(/<[^>]*>/g, "");
	out = decodeEntities(out)
		.replace(/[ \t\f\v\u00a0]+/g, " ")
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
	return out.trim();
}
