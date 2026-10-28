import { afterEach, describe, expect, it } from "vitest";
import {
	cachedQueryEmbedding,
	clearQueryEmbeddingCache,
	QUERY_EMBED_CACHE_MAX,
	queryEmbeddingKey,
	rememberQueryEmbedding,
} from "../src/learn/context.ts";

const vertex = { model: "google-vertex/gemini-embedding-001", baseUrl: "" };

describe("query embedding cache", () => {
	afterEach(() => clearQueryEmbeddingCache());

	it("returns a stored vector for the same endpoint, model, dimensions and text only", () => {
		const key = queryEmbeddingKey(vertex, "hello");
		rememberQueryEmbedding(key, [1, 2, 3]);
		expect(cachedQueryEmbedding(queryEmbeddingKey({ ...vertex }, "hello"))).toEqual([1, 2, 3]);
		expect(cachedQueryEmbedding(queryEmbeddingKey({ ...vertex, dimensions: 256 }, "hello"))).toBeUndefined();
		expect(cachedQueryEmbedding(queryEmbeddingKey({ ...vertex, baseUrl: "http://127.0.0.1:9" }, "hello"))).toBeUndefined();
		expect(cachedQueryEmbedding(queryEmbeddingKey({ model: "openai/text-embedding-3-small", baseUrl: "https://api.openai.com/v1" }, "hello"))).toBeUndefined();
		expect(cachedQueryEmbedding(queryEmbeddingKey(vertex, "hello!"))).toBeUndefined();
	});

	it("evicts the least recently used vector past the cap", () => {
		for (let i = 0; i < QUERY_EMBED_CACHE_MAX; i++) rememberQueryEmbedding(`k${i}`, [i]);
		expect(cachedQueryEmbedding("k0")).toEqual([0]); // k0 is now most recent; k1 is oldest
		rememberQueryEmbedding("new", [9]);
		expect(cachedQueryEmbedding("k1")).toBeUndefined();
		expect(cachedQueryEmbedding("k0")).toEqual([0]);
		expect(cachedQueryEmbedding("new")).toEqual([9]);
	});
});
