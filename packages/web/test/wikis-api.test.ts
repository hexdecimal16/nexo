import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedactor } from "@nexo/telemetry";
import type { WikiListResponse, WikiPageResponse, WikiPagesResponse } from "../public/lib/api-types.ts";
import { renderMarkdown } from "../public/lib/wikis-view.ts";
import { startWebServer, type WebServer } from "../src/index.ts";
import { buildFixture, type Fixture } from "./fixtures.ts";
import { raw } from "./http.ts";

let fx: Fixture;
let server: WebServer;
let wikisDir: string;

beforeAll(async () => {
	fx = buildFixture();
	wikisDir = join(fx.home, "wikis");
	mkdirSync(wikisDir, { recursive: true });

	// Seed test wiki
	const aiWiki = join(wikisDir, "ai");
	mkdirSync(join(aiWiki, "concepts"), { recursive: true });
	writeFileSync(
		join(aiWiki, "index.md"),
		`---
summary: Main AI index
---
# AI Overview

Welcome to the AI wiki. See [[concepts/rag]] or [[concepts/rag|RAG System]].`,
	);
	writeFileSync(
		join(aiWiki, "concepts", "rag.md"),
		`---
summary: Retrieval Augmented Generation details
---
# RAG

RAG connects LLMs to external memory. Refer back to [[index]].
\`\`\`ts
const x = 1;
\`\`\`
`,
	);

	server = await startWebServer({
		db: fx.db,
		redact: createRedactor(),
		port: 0,
		wikisDir,
		now: () => new Date("2026-10-11T00:00:00.000Z"),
	});
});

afterAll(async () => {
	await server.close();
	fx.db.close();
	rmSync(fx.home, { recursive: true, force: true });
});

const get = (path: string, headers?: Record<string, string>) => raw(server.port, path, { headers });

describe("wikis API", () => {
	it("lists available wikis", async () => {
		const res = await get("/api/wikis");
		expect(res.status).toBe(200);
		const data = res.json() as WikiListResponse;
		expect(data.wikis.length).toBe(1);
		expect(data.wikis[0]?.name).toBe("ai");
		expect(data.wikis[0]?.pageCount).toBe(2);
	});

	it("lists pages in a wiki with summary metadata", async () => {
		const res = await get("/api/wikis/ai/pages");
		expect(res.status).toBe(200);
		const data = res.json() as WikiPagesResponse;
		expect(data.wiki).toBe("ai");
		expect(data.pages.length).toBe(2);
		expect(data.pages.map((p) => p.path).sort()).toEqual(["concepts/rag.md", "index.md"]);
		const rag = data.pages.find((p) => p.path === "concepts/rag.md");
		expect(rag?.summary).toBe("Retrieval Augmented Generation details");
		expect(rag?.folder).toBe("concepts");
	});

	it("serves a single wiki page and extracts summary", async () => {
		const res = await get("/api/wikis/ai/page?path=concepts/rag.md");
		expect(res.status).toBe(200);
		const data = res.json() as WikiPageResponse;
		expect(data.wiki).toBe("ai");
		expect(data.path).toBe("concepts/rag.md");
		expect(data.summary).toBe("Retrieval Augmented Generation details");
		expect(data.content).toContain("# RAG");
	});

	it("returns 404 for non-existent wiki or page", async () => {
		const wRes = await get("/api/wikis/missing/pages");
		expect(wRes.status).toBe(404);
		const pRes = await get("/api/wikis/ai/page?path=missing.md");
		expect(pRes.status).toBe(404);
	});

	it("denies path traversal outside wiki", async () => {
		const res = await get("/api/wikis/ai/page?path=../config.json");
		expect(res.status).toBe(403);
	});
});

describe("renderMarkdown", () => {
	it("renders markdown safely and resolves wikilinks", () => {
		const md = `---
summary: Test
---
# Heading

Some text with **bold** and \`code\`.
See [[concepts/rag]] and [[concepts/rag|Custom Label]].
<script>alert('xss')</script>
`;
		const out = renderMarkdown(md, "ai").value;
		expect(out).toContain("<h1>Heading</h1>");
		expect(out).toContain("<strong>bold</strong>");
		expect(out).toContain("<code>code</code>");
		expect(out).toContain('<a href="#ai/concepts/rag" class="wikilink" data-wiki-nav="concepts/rag">concepts/rag</a>');
		expect(out).toContain('<a href="#ai/concepts/rag" class="wikilink" data-wiki-nav="concepts/rag">Custom Label</a>');
		expect(out).not.toContain("<script>");
		expect(out).toContain("&lt;script&gt;");
	});
});
