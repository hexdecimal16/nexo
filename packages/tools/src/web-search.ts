import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

/** The web search APIs `web_search` can query. Each one is used when its key is set. */
export const SEARCH_PROVIDER_IDS = ["brave", "tavily"] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

export interface SearchProviderInfo {
	id: SearchProviderId;
	name: string;
	/** Environment variable that holds the key; it wins over the credentials file. */
	envVar: string;
	/** Where to get a key. */
	signupUrl: string;
}

export const SEARCH_PROVIDERS: Readonly<Record<SearchProviderId, SearchProviderInfo>> = {
	brave: { id: "brave", name: "Brave Search", envVar: "BRAVE_API_KEY", signupUrl: "https://api-dashboard.search.brave.com" },
	tavily: { id: "tavily", name: "Tavily", envVar: "TAVILY_API_KEY", signupUrl: "https://app.tavily.com" },
};

export function isSearchProvider(id: string): id is SearchProviderId {
	return (SEARCH_PROVIDER_IDS as readonly string[]).includes(id);
}

/** One result as a provider returns it, in the shape every provider is mapped to. */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
	/** Publication date or age as the provider gives it. */
	date?: string;
}

/** A result after merging: the providers that returned it, best rank first, and its fused score. */
export interface SearchResult extends SearchHit {
	providers: SearchProviderId[];
	score: number;
}

export interface SearchFailure {
	provider: SearchProviderId;
	/** Never contains the key or the response body. */
	message: string;
}

export interface SearchOutcome {
	results: SearchResult[];
	/** Providers that were queried and failed; the search succeeds while at least one provider answers. */
	failures: SearchFailure[];
	/** Providers that answered, possibly with no results. */
	answered: SearchProviderId[];
}

export interface WebSearchOptions {
	/** Key per provider; providers without a key are skipped. */
	keys: Partial<Record<SearchProviderId, string>>;
	/** Results returned after merging (1 to 20). */
	count: number;
	fetch?: typeof fetch;
	/** Per-provider timeout. */
	timeoutMs?: number;
}

export const MAX_SEARCH_RESULTS = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Reciprocal rank fusion constant; 60 is the value from the original paper and needs no tuning per provider. */
const RRF_K = 60;
const MAX_SNIPPET_CHARS = 400;

class ProviderError extends Error {}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Snippet text without tags and with entities decoded, whitespace collapsed and length capped. */
export function cleanSnippet(text: string): string {
	const decoded = text
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
			const lower = name.toLowerCase();
			if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
			if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
			return ENTITIES[lower] ?? whole;
		})
		.replace(/\s+/g, " ")
		.trim();
	return decoded.length > MAX_SNIPPET_CHARS ? `${decoded.slice(0, MAX_SNIPPET_CHARS - 1)}…` : decoded;
}

const TRACKING_PARAM = /^(utm_.+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_src|_hsenc|_hsmi|igshid)$/i;

/**
 * The key two results are deduplicated by: host lowercased without `www.`, scheme and fragment dropped, tracking
 * parameters removed, the rest sorted, and no trailing slash. Unparsable URLs are their own key.
 */
export function normalizeUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return raw.trim();
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	const port = url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : "";
	const params = [...url.searchParams.entries()].filter(([name]) => !TRACKING_PARAM.test(name)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
	const path = url.pathname.replace(/\/+$/, "");
	return `${host}${port}${path}${query}`;
}

/**
 * Merges ranked lists with reciprocal rank fusion: a result scores the sum of 1/(60 + rank) over the lists that
 * contain it, so agreement between providers lifts it. Duplicates (by `normalizeUrl`) keep the first title and URL
 * and the longest snippet. Ties keep the order of first appearance.
 */
export function fuseResults(lists: readonly { provider: SearchProviderId; hits: readonly SearchHit[] }[], count: number): SearchResult[] {
	const merged = new Map<string, SearchResult & { order: number }>();
	let order = 0;
	for (const { provider, hits } of lists) {
		const seen = new Set<string>();
		hits.forEach((hit, index) => {
			const key = normalizeUrl(hit.url);
			if (seen.has(key)) return;
			seen.add(key);
			const add = 1 / (RRF_K + index + 1);
			const existing = merged.get(key);
			if (!existing) {
				merged.set(key, { ...hit, providers: [provider], score: add, order: order++ });
				return;
			}
			existing.score += add;
			existing.providers.push(provider);
			if (hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet;
			if (!existing.date && hit.date) existing.date = hit.date;
		});
	}
	return [...merged.values()]
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.slice(0, count)
		.map(({ order: _order, ...result }) => result);
}

function statusMessage(status: number): string {
	if (status === 401 || status === 403) return `HTTP ${status}: the API key was rejected`;
	if (status === 402) return "HTTP 402: the plan's quota or credits are used up";
	if (status === 429) return "HTTP 429: rate limited";
	return `HTTP ${status}`;
}

/** Error codes a provider puts in its JSON error body that mean the key itself is bad. */
const KEY_ERROR_CODES = new Set(["SUBSCRIPTION_TOKEN_INVALID"]);

async function getJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
	const response = await fetchImpl(url, init);
	if (!response.ok) {
		// Brave answers a bad key with 422 and an error code; only that code is read, never the rest of the body.
		let code: unknown;
		try {
			code = record(record(await response.json()).error).code;
		} catch {
			code = undefined;
		}
		throw new ProviderError(typeof code === "string" && KEY_ERROR_CODES.has(code) ? `HTTP ${response.status}: the API key was rejected` : statusMessage(response.status));
	}
	try {
		return await response.json();
	} catch {
		throw new ProviderError("the response was not JSON");
	}
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function toHits(items: unknown, map: (item: Record<string, unknown>) => SearchHit | null): SearchHit[] {
	if (!Array.isArray(items)) throw new ProviderError("the response had no result list");
	return items.map((item) => map(record(item))).filter((hit): hit is SearchHit => hit !== null);
}

type ProviderSearch = (query: string, count: number, key: string, fetchImpl: typeof fetch, signal: AbortSignal) => Promise<SearchHit[]>;

const PROVIDER_SEARCH: Record<SearchProviderId, ProviderSearch> = {
	brave: async (query, count, key, fetchImpl, signal) => {
		const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(count) })}`;
		const body = record(await getJson(fetchImpl, url, { signal, headers: { Accept: "application/json", "X-Subscription-Token": key } }));
		// A query with no web results has no `web` section at all.
		if (body.web === undefined) return [];
		return toHits(record(body.web).results, (item) => {
			const link = str(item.url);
			if (!link) return null;
			const date = str(item.page_age) ?? str(item.age);
			return { title: cleanSnippet(str(item.title) ?? link), url: link, snippet: cleanSnippet(str(item.description) ?? ""), ...(date ? { date } : {}) };
		});
	},
	tavily: async (query, count, key, fetchImpl, signal) => {
		const body = record(
			await getJson(fetchImpl, "https://api.tavily.com/search", {
				method: "POST",
				signal,
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
			}),
		);
		return toHits(body.results, (item) => {
			const link = str(item.url);
			if (!link) return null;
			const date = str(item.published_date);
			return { title: cleanSnippet(str(item.title) ?? link), url: link, snippet: cleanSnippet(str(item.content) ?? ""), ...(date ? { date } : {}) };
		});
	},
};

/** The providers `web_search` would query: the ones with a key, in SEARCH_PROVIDER_IDS order. */
export function configuredSearchProviders(keys: Partial<Record<SearchProviderId, string>>): SearchProviderId[] {
	return SEARCH_PROVIDER_IDS.filter((id) => (keys[id] ?? "").trim() !== "");
}

/**
 * Queries every provider that has a key in parallel and fuses their results. A failing provider is reported in
 * `failures` and does not fail the search. Throws only on an empty query, without any key, or when aborted.
 */
export async function webSearch(query: string, options: WebSearchOptions, signal?: AbortSignal): Promise<SearchOutcome> {
	const q = query.trim();
	if (q === "") throw new Error("The search query is empty");
	const providers = configuredSearchProviders(options.keys);
	if (providers.length === 0) throw new Error(noKeyMessage());
	const count = Math.min(Math.max(1, Math.floor(options.count)), MAX_SEARCH_RESULTS);
	const fetchImpl = options.fetch ?? fetch;
	const settled = await Promise.allSettled(
		providers.map((provider) => {
			const combined = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS), ...(signal ? [signal] : [])]);
			return PROVIDER_SEARCH[provider](q, count, (options.keys[provider] as string).trim(), fetchImpl, combined);
		}),
	);
	if (signal?.aborted) throw new Error("Search aborted");
	const lists: { provider: SearchProviderId; hits: SearchHit[] }[] = [];
	const failures: SearchFailure[] = [];
	settled.forEach((outcome, i) => {
		const provider = providers[i] as SearchProviderId;
		if (outcome.status === "fulfilled") lists.push({ provider, hits: outcome.value });
		else failures.push({ provider, message: failureMessage(outcome.reason) });
	});
	return { results: fuseResults(lists, count), failures, answered: lists.map((l) => l.provider) };
}

function failureMessage(reason: unknown): string {
	if (reason instanceof ProviderError) return reason.message;
	if (reason instanceof Error && (reason.name === "TimeoutError" || reason.name === "AbortError")) return "timed out";
	// Network errors from fetch carry no key; anything else is reported by type only.
	if (reason instanceof TypeError) return `network error (${reason.message})`;
	return "request failed";
}

export function noKeyMessage(): string {
	const lines = SEARCH_PROVIDER_IDS.map((id) => `${SEARCH_PROVIDERS[id].name}: nexo settings set-key ${id} (or ${SEARCH_PROVIDERS[id].envVar}); get a key at ${SEARCH_PROVIDERS[id].signupUrl}`);
	return `Web search has no API key. Set one of:\n${lines.join("\n")}`;
}

/** The outcome as the text the agent reads: numbered markdown links with snippets, then any provider failures. */
export function formatSearchOutcome(query: string, outcome: SearchOutcome): string {
	const failed = outcome.failures.map((f) => `${f.provider} (${f.message})`).join("; ");
	if (outcome.answered.length === 0) return `Web search failed: ${failed}`;
	const lines: string[] = [];
	if (outcome.results.length === 0) lines.push(`No results for "${query}".`);
	outcome.results.forEach((r, i) => {
		lines.push(`${i + 1}. [${r.title.replace(/[[\]]/g, "")}](${r.url})`);
		if (r.snippet) lines.push(`   ${r.snippet}`);
		lines.push(`   (${[r.providers.join(", "), r.date].filter(Boolean).join(" · ")})`);
	});
	if (outcome.failures.length > 0) {
		lines.push("", `Not included: ${failed}`);
	}
	return lines.join("\n");
}

export const WEB_SEARCH_DESCRIPTION = `Search the web and return ranked results as [title](url) with a snippet. Queries every configured search API (Brave, Tavily) in parallel and merges their results; results found by several providers rank higher. Use it to find current information, documentation, error messages and URLs, then read the best hits with web_fetch and cite them. Write specific queries (names, versions, exact error text). count: results to return (default from config, at most ${MAX_SEARCH_RESULTS}).`;

const SearchParams = Type.Object({
	query: Type.String({ minLength: 1, description: "What to search for" }),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS, description: "Number of results" })),
});

function textResult(text: string, isError = false): AgentToolResult<undefined> {
	return isError ? { content: [{ type: "text", text }], details: undefined, isError: true } : { content: [{ type: "text", text }], details: undefined };
}

/** The `web_search` tool, or null when no provider has a key (the agent then never sees it). */
export function createWebSearchTool(options: WebSearchOptions): AgentTool<typeof SearchParams> | null {
	if (configuredSearchProviders(options.keys).length === 0) return null;
	return {
		name: "web_search",
		label: "Search web",
		description: WEB_SEARCH_DESCRIPTION,
		parameters: SearchParams,
		execute: async (_id, params, signal) => {
			const outcome = await webSearch(params.query, { ...options, count: params.count ?? options.count }, signal);
			return textResult(formatSearchOutcome(params.query.trim(), outcome), outcome.answered.length === 0);
		},
	};
}
