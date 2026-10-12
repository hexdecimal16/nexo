import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNexoPaths } from "@nexo/store";
import { DEFAULT_CONFIG, embeddingCost, embeddingEndpoint, embedTexts, loadConfig, reflectorModelSpec } from "../src/index.ts";
import { embeddingServer } from "./learn-helpers.ts";

const models = { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } };

function load(home: object, project?: object) {
	const root = mkdtempSync(join(tmpdir(), "nexo-learn-cfg-"));
	const paths = resolveNexoPaths({ NEXO_HOME: join(root, "home") });
	const cwd = join(root, "proj");
	mkdirSync(paths.home, { recursive: true });
	mkdirSync(join(cwd, ".nexo"), { recursive: true });
	writeFileSync(paths.config, JSON.stringify(home));
	if (project) writeFileSync(join(cwd, ".nexo", "config.json"), JSON.stringify(project));
	return () => loadConfig({ paths, cwd }).config;
}

describe("memory and learning config", () => {
	it("fills the spec §9 defaults and resolves the reflector to s1", () => {
		const config = load({ models })();
		expect(config.memory).toEqual({ enabled: true, maxTokens: 1500, weights: { relevance: 1, importance: 0.5, recency: 0.3 }, tauDays: 14, topK: 20 });
		expect(config.learning).toEqual({ enabled: true, maxPlaybookItems: 50, perJobUsd: 0.15, staleMinutes: 10, drainAfterRunMs: 30_000 });
		expect(DEFAULT_CONFIG.learning.maxPlaybookItems).toBe(50);
		expect(reflectorModelSpec(config)).toEqual(models.s1);
		expect(reflectorModelSpec({ ...config, models: { ...config.models, reflector: { ref: "s2" } } })).toEqual(models.s2);
		expect(reflectorModelSpec({ ...config, models: { ...config.models, reflector: { provider: "faux", id: "free" } } })).toEqual({ provider: "faux", id: "free" });
		expect(embeddingEndpoint(config)).toBeNull();
	});

	it("rejects unknown keys and out-of-range values at their exact path", () => {
		expect(() => load({ models, memory: { maxTokens: 10, extra: 1 } })()).toThrow(/\/memory\/extra is not a recognized setting/);
		expect(() => load({ models, memory: { tauDays: 0 } })()).toThrow(/\/memory\/tauDays/);
		expect(() => load({ models, learning: { maxPlaybookItems: 0 } })()).toThrow(/\/learning\/maxPlaybookItems/);
		expect(() => load({ models, learning: { enabled: "yes" } })()).toThrow(/\/learning\/enabled/);
	});

	it("defaults the OpenAI base URL, requires one for other providers and refuses an embedding model from a project config", () => {
		const openai = load({ models: { ...models, embedding: { provider: "openai", id: "text-embedding-3-small" } } })();
		expect(embeddingEndpoint(openai)).toEqual({ provider: "openai", id: "text-embedding-3-small", model: "openai/text-embedding-3-small", baseUrl: "https://api.openai.com/v1" });
		expect(() => load({ models: { ...models, embedding: { provider: "acme", id: "e1" } } })()).toThrow(/\/models\/embedding\/baseUrl is required for provider "acme"/);
		const custom = load({ models: { ...models, embedding: { provider: "acme", id: "e1", baseUrl: "http://127.0.0.1:9/v1/", dimensions: 64 } } })();
		expect(embeddingEndpoint(custom)).toMatchObject({ baseUrl: "http://127.0.0.1:9/v1", dimensions: 64 });
		expect(() => load({ models }, { models: { ...models, embedding: { provider: "openai", id: "e", baseUrl: "https://evil.example/v1" } } })()).toThrow(
			/\/models\/embedding must not be set in \.\/\.nexo\/config\.json/,
		);
	});
});

describe("embedTexts", () => {
	const endpoint = (baseUrl: string) => ({ provider: "acme", id: "e1", model: "acme/e1", baseUrl, dimensions: 2 });

	it("posts the OpenAI wire format, orders vectors by index and reports tokens", async () => {
		const server = await embeddingServer();
		try {
			const result = await embedTexts(endpoint(server.baseUrl), ["alpha one", "beta two"], { apiKey: "test-key-123456" });
			expect(result).toEqual({ vectors: [[1, 0], [0, 1]], tokens: 6 });
			expect(server.requests[0]?.body).toEqual({ model: "e1", input: ["alpha one", "beta two"], dimensions: 2 });
			expect(server.requests[0]?.headers.authorization).toBe("Bearer test-key-123456");
			expect(await embedTexts(endpoint(server.baseUrl), [], { apiKey: "test-key-123456" })).toEqual({ vectors: [], tokens: 0 });
			expect(server.requests).toHaveLength(1);
		} finally {
			await server.close();
		}
	});

	it("maps HTTP failures to provider codes without echoing the key", async () => {
		const cases: [number, string, boolean][] = [
			[401, "PROVIDER_AUTH", false],
			[429, "PROVIDER_RATE_LIMIT", true],
			[503, "PROVIDER_UNAVAILABLE", true],
			[400, "PROVIDER_UNAVAILABLE", false],
		];
		for (const [status, code, retryable] of cases) {
			const server = await embeddingServer(() => ({ status, body: { error: "nope" } }));
			try {
				const error = await embedTexts(endpoint(server.baseUrl), ["x"], { apiKey: "secret-key-abcdef" }).catch((e: unknown) => e);
				expect(error).toMatchObject({ code, retryable });
				expect(JSON.stringify(error)).not.toContain("secret-key-abcdef");
				expect((error as Error).message).not.toContain("secret-key-abcdef");
			} finally {
				await server.close();
			}
		}
	});

	it("rejects a missing key, a malformed reply, a count mismatch and a hung endpoint", async () => {
		await expect(embedTexts(endpoint("http://127.0.0.1:9/v1"), ["x"], { apiKey: undefined })).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
		const bad = await embeddingServer(() => ({ status: 200, body: { data: [{ index: 0, embedding: ["a"] }] } }));
		const short = await embeddingServer(() => ({ status: 200, body: { data: [{ index: 0, embedding: [1] }] } }));
		const hung = await embeddingServer(() => null);
		try {
			await expect(embedTexts(endpoint(bad.baseUrl), ["x"], { apiKey: "k-12345678" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: expect.stringContaining("malformed") });
			await expect(embedTexts(endpoint(short.baseUrl), ["x", "y"], { apiKey: "k-12345678" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: expect.stringContaining("1 vectors for 2 texts") });
			await expect(embedTexts(endpoint(hung.baseUrl), ["x"], { apiKey: "k-12345678", timeoutMs: 100 })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
		} finally {
			await Promise.all([bad.close(), short.close(), hung.close()]);
		}
	});

	it("rejects a duplicate or fractional index instead of returning a sparse array", async () => {
		const dup = await embeddingServer(() => ({ status: 200, body: { data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] } }));
		const frac = await embeddingServer(() => ({ status: 200, body: { data: [{ index: 0, embedding: [1] }, { index: 0.5, embedding: [2] }] } }));
		try {
			await expect(embedTexts(endpoint(dup.baseUrl), ["x", "y"], { apiKey: "k-12345678" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: expect.stringContaining("malformed") });
			await expect(embedTexts(endpoint(frac.baseUrl), ["x", "y"], { apiKey: "k-12345678" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: expect.stringContaining("malformed") });
		} finally {
			await Promise.all([dup.close(), frac.close()]);
		}
	});

	it("estimates tokens as chars/4 when the reply has no usage, so cost is never a known $0", async () => {
		const server = await embeddingServer((input) => ({ status: 200, body: { data: input.map((_, index) => ({ index, embedding: [1, 0] })) } }));
		try {
			const result = await embedTexts(endpoint(server.baseUrl), ["12345678", "1234"], { apiKey: "k-12345678" });
			expect(result).toEqual({ vectors: [[1, 0], [1, 0]], tokens: 3, tokensEstimated: true });
			const priced = load({ models, pricingOverrides: { "acme/e1": { input: 2, output: 0 } } })();
			expect(embeddingCost(priced, endpoint("x"), result.tokens)).toEqual({ costUsd: 6e-6, costUnknown: false });
			const unpriced = load({ models })();
			expect(embeddingCost(unpriced, endpoint("x"), result.tokens)).toEqual({ costUsd: 0, costUnknown: true });
		} finally {
			await server.close();
		}
	});

	it("prices embeddings from pricingOverrides and flags them unknown otherwise", () => {
		const config = load({ models, pricingOverrides: { "acme/e1": { input: 0.02, output: 0 } } })();
		expect(embeddingCost(config, endpoint("x"), 1_000_000)).toEqual({ costUsd: 0.02, costUnknown: false });
		expect(embeddingCost(config, { ...endpoint("x"), model: "acme/other" }, 10)).toEqual({ costUsd: 0, costUnknown: true });
		expect(embeddingCost(config, { ...endpoint("x"), model: "acme/other" }, 0)).toEqual({ costUsd: 0, costUnknown: false });
	});
});
