import { describe, expect, it } from "vitest";
import {
	cleanSnippet,
	createWebSearchTool,
	formatSearchOutcome,
	fuseResults,
	normalizeUrl,
	webSearch,
	type WebSearchOptions,
} from "../src/index.ts";

const BRAVE_KEY = "brave-key-0123456789";
const TAVILY_KEY = "tvly-key-0123456789";

interface Call {
	url: string;
	init: RequestInit | undefined;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function braveBody(urls: string[]) {
	return { web: { results: urls.map((url, i) => ({ title: `Brave <strong>${i}</strong>`, url, description: `brave &amp; snippet ${i}`, page_age: "2026-10-01" })) } };
}

function tavilyBody(urls: string[]) {
	return { results: urls.map((url, i) => ({ title: `Tavily ${i}`, url, content: `tavily snippet ${i} longer text`, score: 0.9 })) };
}

function fakeFetch(handlers: { brave?: () => Response | Promise<Response>; tavily?: () => Response | Promise<Response> }, calls: Call[] = []): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		if (url.startsWith("https://api.search.brave.com/") && handlers.brave) return handlers.brave();
		if (url === "https://api.tavily.com/search" && handlers.tavily) return handlers.tavily();
		throw new TypeError("fetch failed");
	}) as typeof fetch;
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

describe("normalizeUrl", () => {
	it("ignores scheme, www, case of host, trailing slash, fragment and tracking parameters", () => {
		const a = normalizeUrl("https://www.Example.com/docs/?utm_source=x&b=2&a=1#top");
		const b = normalizeUrl("http://example.com/docs?a=1&b=2&fbclid=123");
		expect(a).toBe(b);
		expect(a).toBe("example.com/docs?a=1&b=2");
	});

	it("keeps paths and non-default ports distinct", () => {
		expect(normalizeUrl("https://x.test/a")).not.toBe(normalizeUrl("https://x.test/b"));
		expect(normalizeUrl("https://x.test:8443/a")).toBe("x.test:8443/a");
	});
});

describe("cleanSnippet", () => {
	it("strips tags, decodes entities and collapses whitespace", () => {
		expect(cleanSnippet("<strong>Node</strong>&nbsp;22 &amp; &#x263A;\n  ok &#39;q&#39;")).toBe("Node 22 & ☺ ok 'q'");
	});

	it("caps long snippets", () => {
		expect(cleanSnippet("a".repeat(1000)).length).toBe(400);
	});
});

describe("fuseResults", () => {
	it("ranks results found by several providers above single-provider ones and merges their sources", () => {
		const fused = fuseResults(
			[
				{ provider: "brave", hits: [{ title: "only brave", url: "https://a.test/1", snippet: "s" }, { title: "both", url: "https://b.test/", snippet: "short" }] },
				{ provider: "tavily", hits: [{ title: "only tavily", url: "https://c.test/1", snippet: "s" }, { title: "both t", url: "https://www.b.test", snippet: "a longer snippet", date: "2026" }] },
			],
			10,
		);
		expect(fused.map((r) => r.title)).toEqual(["both", "only brave", "only tavily"]);
		expect(fused[0]).toMatchObject({ providers: ["brave", "tavily"], snippet: "a longer snippet", date: "2026", url: "https://b.test/" });
	});

	it("drops a provider's own duplicates and honours count", () => {
		const fused = fuseResults([{ provider: "brave", hits: [{ title: "1", url: "https://a.test", snippet: "" }, { title: "dup", url: "https://a.test/", snippet: "" }, { title: "2", url: "https://b.test", snippet: "" }] }], 1);
		expect(fused).toHaveLength(1);
		expect(fused[0]?.title).toBe("1");
	});
});

describe("webSearch", () => {
	const options = (fetchImpl: typeof fetch, keys: WebSearchOptions["keys"] = { brave: BRAVE_KEY, tavily: TAVILY_KEY }): WebSearchOptions => ({ keys, count: 5, fetch: fetchImpl });

	it("queries both providers with their own auth and merges the results", async () => {
		const calls: Call[] = [];
		const f = fakeFetch({ brave: () => json(braveBody(["https://a.test", "https://shared.test"])), tavily: () => json(tavilyBody(["https://shared.test/", "https://t.test"])) }, calls);
		const outcome = await webSearch("  node 22 release  ", options(f));
		expect(outcome.answered).toEqual(["brave", "tavily"]);
		expect(outcome.failures).toEqual([]);
		expect(outcome.results[0]?.url).toBe("https://shared.test");
		expect(outcome.results[0]?.providers).toEqual(["brave", "tavily"]);
		expect(outcome.results).toHaveLength(3);

		const brave = calls.find((c) => c.url.includes("brave")) as Call;
		expect(new URL(brave.url).searchParams.get("q")).toBe("node 22 release");
		expect(new URL(brave.url).searchParams.get("count")).toBe("5");
		expect((brave.init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe(BRAVE_KEY);
		const tavily = calls.find((c) => c.url.includes("tavily")) as Call;
		expect((tavily.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TAVILY_KEY}`);
		expect(JSON.parse(String(tavily.init?.body))).toEqual({ query: "node 22 release", max_results: 5, search_depth: "basic" });
	});

	it("skips providers without a key", async () => {
		const calls: Call[] = [];
		const f = fakeFetch({ tavily: () => json(tavilyBody(["https://t.test"])) }, calls);
		const outcome = await webSearch("q", options(f, { tavily: TAVILY_KEY, brave: "  " }));
		expect(calls).toHaveLength(1);
		expect(outcome.answered).toEqual(["tavily"]);
	});

	it("keeps the answering provider's results when the other fails, and never reports keys or bodies", async () => {
		const f = fakeFetch({ brave: () => new Response(`bad token ${BRAVE_KEY}`, { status: 401 }), tavily: () => json(tavilyBody(["https://t.test"])) });
		const outcome = await webSearch("q", options(f));
		expect(outcome.results.map((r) => r.url)).toEqual(["https://t.test"]);
		expect(outcome.failures).toEqual([{ provider: "brave", message: "HTTP 401: the API key was rejected" }]);
		expect(JSON.stringify(outcome)).not.toContain(BRAVE_KEY);
	});

	it("reads brave's 422 token error as a rejected key without echoing the body", async () => {
		const body = { error: { code: "SUBSCRIPTION_TOKEN_INVALID", detail: `bad ${BRAVE_KEY}`, status: 422 }, type: "ErrorResponse" };
		const outcome = await webSearch("q", options(fakeFetch({ brave: () => json(body, 422) }), { brave: BRAVE_KEY }));
		expect(outcome.failures).toEqual([{ provider: "brave", message: "HTTP 422: the API key was rejected" }]);
		const other = await webSearch("q", options(fakeFetch({ brave: () => json({ error: { code: "OTHER" } }, 422) }), { brave: BRAVE_KEY }));
		expect(other.failures[0]?.message).toBe("HTTP 422");
	});

	it("reports rate limits, network errors and malformed bodies per provider", async () => {
		const f = fakeFetch({ brave: () => new Response("", { status: 429 }), tavily: () => json({ nope: true }) });
		const outcome = await webSearch("q", options(f));
		expect(outcome.answered).toEqual([]);
		expect(outcome.failures.map((x) => x.message)).toEqual(["HTTP 429: rate limited", "the response had no result list"]);
		const offline = await webSearch("q", options(fakeFetch({})));
		expect(offline.failures.map((x) => x.message)).toEqual(["network error (fetch failed)", "network error (fetch failed)"]);
	});

	it("treats a brave response without a web section as no results", async () => {
		const outcome = await webSearch("q", options(fakeFetch({ brave: () => json({ type: "search" }) }), { brave: BRAVE_KEY }));
		expect(outcome).toEqual({ results: [], failures: [], answered: ["brave"] });
	});

	it("times out a slow provider without failing the search", async () => {
		const f = (async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).includes("brave")) {
				return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
			}
			return json(tavilyBody(["https://t.test"]));
		}) as typeof fetch;
		const outcome = await webSearch("q", { keys: { brave: BRAVE_KEY, tavily: TAVILY_KEY }, count: 3, fetch: f, timeoutMs: 20 });
		expect(outcome.failures).toEqual([{ provider: "brave", message: "timed out" }]);
		expect(outcome.answered).toEqual(["tavily"]);
	});

	it("rejects an empty query and a missing key", async () => {
		await expect(webSearch("   ", options(fakeFetch({})))).rejects.toThrow(/empty/);
		await expect(webSearch("q", options(fakeFetch({}), {}))).rejects.toThrow(/nexo settings set-key brave/);
	});
});

describe("web_search tool", () => {
	it("is not created without a key", () => {
		expect(createWebSearchTool({ keys: {}, count: 5 })).toBeNull();
	});

	it("returns numbered markdown links with sources, and honours count", async () => {
		const tool = createWebSearchTool({ keys: { brave: BRAVE_KEY }, count: 5, fetch: fakeFetch({ brave: () => json(braveBody(["https://a.test", "https://b.test", "https://c.test"])) }) });
		const result = await tool?.execute("1", { query: "x", count: 2 });
		const out = text(result as never);
		expect(out).toContain("1. [Brave 0](https://a.test)\n   brave & snippet 0\n   (brave · 2026-10-01)");
		expect(out).toContain("2. [Brave 1](https://b.test)");
		expect(out).not.toContain("c.test");
	});

	it("is an error when every provider fails", async () => {
		const tool = createWebSearchTool({ keys: { brave: BRAVE_KEY }, count: 5, fetch: fakeFetch({ brave: () => new Response("", { status: 402 }) }) });
		const result = await tool?.execute("1", { query: "x" });
		expect(result?.isError).toBe(true);
		expect(text(result as never)).toBe("Web search failed: brave (HTTP 402: the plan's quota or credits are used up)");
	});

	it("names the providers left out when one fails", () => {
		const out = formatSearchOutcome("q", { results: [], failures: [{ provider: "tavily", message: "timed out" }], answered: ["brave"] });
		expect(out).toBe('No results for "q".\n\nNot included: tavily (timed out)');
	});
});
