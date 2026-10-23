import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { htmlToText, looksLikeHtml } from "../src/html-text.ts";
import { createBuiltinTools, FileLeases, type ToolContext } from "../src/index.ts";

const PAGE = `<!doctype html><html><head><title>T</title><style>.a{color:red}</style><script>var secret = 1;</script></head>
<body><nav><a href="/home">Home</a></nav>
<header><h1>Harness & tools</h1></header>
<main><p>First <b>bold</b> paragraph&nbsp;with an <a href="https://x.test/a?b=1&c=2">inline link</a>.</p>
<ul><li>one</li><li>two</li></ul>
<!-- hidden comment --><noscript>enable js</noscript><a href="#top">Top</a>
<p>Caf&#233; &#x263A; &unknown;</p></main>
<footer>(c) 2026 footer text</footer><script>track()</script></body></html>`;

describe("htmlToText", () => {
	it("drops scripts, styles, nav, footer, comments and noscript", () => {
		const out = htmlToText(PAGE);
		for (const gone of ["secret", "color:red", "Home", "footer text", "hidden comment", "enable js", "track()", "<"]) {
			expect(out).not.toContain(gone);
		}
	});

	it("keeps headings, list items, links and decoded entities", () => {
		const out = htmlToText(PAGE);
		expect(out).toContain("# Harness & tools");
		expect(out).toContain("First bold paragraph with an [inline link](https://x.test/a?b=1&c=2).");
		expect(out).toContain("- one\n- two");
		expect(out).toContain("Top");
		expect(out).not.toContain("(#top)");
		expect(out).toContain("Caf\u00e9 \u263a &unknown;");
	});

	it("detects html without a content type", () => {
		expect(looksLikeHtml("  <!DOCTYPE html><p>x</p>")).toBe(true);
		expect(looksLikeHtml("# markdown")).toBe(false);
	});
});

function setup(fetchImpl: typeof fetch) {
	const ctx: ToolContext = {
		workspaceRoot: mkdtempSync(join(tmpdir(), "nexo-fetch-")),
		holder: "run-1",
		leases: new FileLeases(),
		bashTimeoutMs: 5000,
		fetch: fetchImpl,
	};
	const tool = createBuiltinTools(ctx).find((t) => t.name === "web_fetch") as AgentTool<any>;
	return (url: string) => tool.execute("1", { url });
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { "content-type": "text/html; charset=utf-8", ...init.headers } });

describe("web_fetch conversion", () => {
	it("returns text for an html response and asks for markdown first", async () => {
		let accept = "";
		const run = setup((async (_u: string, init?: RequestInit) => {
			accept = new Headers(init?.headers).get("accept") ?? "";
			return html(PAGE);
		}) as typeof fetch);
		const out = text(await run("https://x.test/page"));
		expect(accept.startsWith("text/markdown")).toBe(true);
		expect(out).toContain("# Harness & tools");
		expect(out).not.toContain("secret");
	});

	it("passes markdown through unchanged", async () => {
		const md = "# Title\n\n<b>kept</b>";
		const run = setup((async () => new Response(md, { headers: { "content-type": "text/markdown" } })) as unknown as typeof fetch);
		expect(text(await run("https://x.test/doc.md"))).toBe(md);
	});

	it("retries once with a plain user agent on a Cloudflare challenge", async () => {
		const agents: string[] = [];
		const run = setup((async (_u: string, init?: RequestInit) => {
			const ua = new Headers(init?.headers).get("user-agent") ?? "";
			agents.push(ua);
			return ua === "nexo" ? html("<p>through</p>") : html("blocked", { status: 403, headers: { "cf-mitigated": "challenge" } });
		}) as typeof fetch);
		expect(text(await run("https://x.test/p"))).toBe("through");
		expect(agents.length).toBe(2);
	});

	it("points at the browser skill when the challenge persists", async () => {
		const run = setup((async () => html("blocked", { status: 403, headers: { "cf-mitigated": "challenge" } })) as unknown as typeof fetch);
		const result = await run("https://x.test/p");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("HTTP 403");
		expect(text(result)).toContain("browser skill");
	});

	it("refuses binary content types", async () => {
		const run = setup((async () => new Response("%PDF", { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch);
		const result = await run("https://x.test/a.pdf");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("application/pdf");
	});

	it("caps long output with a note", async () => {
		const run = setup((async () => new Response("a".repeat(150_000), { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch);
		const out = text(await run("https://x.test/big"));
		expect(out.length).toBeLessThan(100_100);
		expect(out).toContain("[truncated at 100000 characters]");
	});
});
