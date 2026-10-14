import { readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname } from "node:path";
import { NexoError } from "@nexo/telemetry";
import { resolveConfined } from "@nexo/tools";
import { SECURITY_HEADERS } from "./http-errors.ts";
import { stripBrowserTypeScript } from "./strip.ts";

/** Placeholder in public HTML files that is replaced with the per-launch token. */
export const TOKEN_PLACEHOLDER = "{{NEXO_TOKEN}}";

/** Pages may load only their own scripts, styles and API; no inline script, no framing. */
export const PAGE_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".ts": "text/javascript; charset=utf-8",
};

export interface StaticServer {
	serve(res: ServerResponse, urlPath: string): void;
}

function notFound(urlPath: string): NexoError {
	return new NexoError({ code: "NOT_FOUND", message: `No page at ${urlPath}`, context: { path: urlPath } });
}

/**
 * Serves `.html` (with the token filled in), `.css` and browser `.ts` (type-stripped, cached by mtime) from
 * `publicDir`. Paths are confined with `resolveConfined`; any other extension is a 404.
 */
export function createStaticServer(publicDir: string, token: string): StaticServer {
	const stripped = new Map<string, { mtimeMs: number; code: string }>();

	const load = (file: string, ext: string, urlPath: string): string => {
		const source = readFileSync(file, "utf8");
		if (ext === ".html") return source.replaceAll(TOKEN_PLACEHOLDER, token);
		if (ext !== ".ts") return source;
		const mtimeMs = statSync(file).mtimeMs;
		const cached = stripped.get(file);
		if (cached && cached.mtimeMs === mtimeMs) return cached.code;
		const code = stripBrowserTypeScript(source, urlPath);
		stripped.set(file, { mtimeMs, code });
		return code;
	};

	return {
		serve(res, urlPath) {
			let rel: string;
			try {
				rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
			} catch {
				throw notFound(urlPath);
			}
			const ext = extname(rel);
			const type = TYPES[ext];
			if (!type || rel.includes("\0")) throw notFound(urlPath);
			let file: string;
			try {
				file = resolveConfined(publicDir, rel);
			} catch {
				throw notFound(urlPath);
			}
			let body: string;
			try {
				if (!statSync(file).isFile()) throw notFound(urlPath);
				body = load(file, ext, urlPath);
			} catch (error) {
				if (error instanceof NexoError) throw error;
				if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound(urlPath);
				throw error;
			}
			res.writeHead(200, {
				...SECURITY_HEADERS,
				"content-type": type,
				"cache-control": "no-cache",
				...(ext === ".html" ? { "content-security-policy": PAGE_CSP } : {}),
				"content-length": Buffer.byteLength(body),
			});
			res.end(body);
		},
	};
}
