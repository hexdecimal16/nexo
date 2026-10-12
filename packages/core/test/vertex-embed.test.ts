import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, type EmbedContentParameters, type EmbedContentResponse } from "@google/genai";
import { describe, expect, it } from "vitest";
import { resolveNexoPaths } from "@nexo/store";
import { embeddingEndpoint, embedTexts, loadConfig, type VertexEmbedClient } from "../src/index.ts";

const models = { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } };
const env = { GOOGLE_CLOUD_PROJECT: "proj-1", GOOGLE_CLOUD_LOCATION: "global" };
const endpoint = { provider: "google-vertex", id: "gemini-embedding-001", model: "google-vertex/gemini-embedding-001", baseUrl: "", dimensions: 2 };

function load(home: object) {
	const root = mkdtempSync(join(tmpdir(), "nexo-vertex-cfg-"));
	const paths = resolveNexoPaths({ NEXO_HOME: join(root, "home") });
	mkdirSync(paths.home, { recursive: true });
	writeFileSync(paths.config, JSON.stringify(home));
	return () => loadConfig({ paths, cwd: root }).config;
}

/** A client that answers each request from `reply` and records the requests. */
function fakeClient(reply: (params: EmbedContentParameters) => Promise<EmbedContentResponse> | EmbedContentResponse): VertexEmbedClient & { calls: EmbedContentParameters[] } {
	const calls: EmbedContentParameters[] = [];
	return {
		calls,
		models: {
			embedContent: async (params) => {
				calls.push(params);
				return reply(params);
			},
		},
	};
}

const textOf = (params: EmbedContentParameters) => String(params.contents);

describe("google-vertex embedding config", () => {
	it("needs no baseUrl for google-vertex and refuses one", () => {
		const config = load({ models: { ...models, embedding: { provider: "google-vertex", id: "gemini-embedding-001" } } })();
		expect(embeddingEndpoint(config)).toEqual({ provider: "google-vertex", id: "gemini-embedding-001", model: "google-vertex/gemini-embedding-001", baseUrl: "" });
		expect(() => load({ models: { ...models, embedding: { provider: "google-vertex", id: "e", baseUrl: "https://example.com/v1" } } })()).toThrow(
			/\/models\/embedding\/baseUrl is not used for provider "google-vertex"/,
		);
	});
});

describe("embedTexts with google-vertex", () => {
	it("sends one request per text and returns vectors in order with the reported tokens", async () => {
		const client = fakeClient((params) => ({ embeddings: [{ values: textOf(params) === "alpha" ? [1, 0] : [0, 1], statistics: { tokenCount: 3 } }] }));
		const result = await embedTexts(endpoint, ["alpha", "beta"], { apiKey: undefined, env, vertexClient: client });
		expect(result).toEqual({ vectors: [[1, 0], [0, 1]], tokens: 6 });
		expect(client.calls.map((c) => [c.model, textOf(c), c.config?.outputDimensionality])).toEqual([
			["gemini-embedding-001", "alpha", 2],
			["gemini-embedding-001", "beta", 2],
		]);
	});

	it("estimates tokens as chars/4 when the reply has no statistics", async () => {
		const client = fakeClient(() => ({ embeddings: [{ values: [1, 0] }] }));
		expect(await embedTexts(endpoint, ["12345678", "1234"], { apiKey: undefined, env, vertexClient: client })).toEqual({ vectors: [[1, 0], [1, 0]], tokens: 3, tokensEstimated: true });
	});

	it("refuses without a project or location", async () => {
		const client = fakeClient(() => ({ embeddings: [{ values: [1] }] }));
		await expect(embedTexts(endpoint, ["x"], { apiKey: undefined, env: { GOOGLE_CLOUD_LOCATION: "global" }, vertexClient: client })).rejects.toMatchObject({
			code: "PROVIDER_AUTH",
			hint: expect.stringContaining("GOOGLE_CLOUD_PROJECT"),
		});
		await expect(embedTexts(endpoint, ["x"], { apiKey: undefined, env: { GCLOUD_PROJECT: "p" }, vertexClient: client })).rejects.toMatchObject({
			code: "PROVIDER_AUTH",
			hint: expect.stringContaining("GOOGLE_CLOUD_LOCATION"),
		});
		expect(client.calls).toHaveLength(0);
	});

	it("maps API errors by HTTP status", async () => {
		const failing = (status: number) => fakeClient(() => Promise.reject(new ApiError({ message: "nope", status })));
		await expect(embedTexts(endpoint, ["x"], { apiKey: undefined, env, vertexClient: failing(403) })).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
		await expect(embedTexts(endpoint, ["x"], { apiKey: undefined, env, vertexClient: failing(429) })).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMIT", retryable: true });
		await expect(embedTexts(endpoint, ["x"], { apiKey: undefined, env, vertexClient: failing(503) })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
	});

	it("reports missing credentials as PROVIDER_AUTH and other failures as PROVIDER_UNAVAILABLE", async () => {
		const noCreds = fakeClient(() => Promise.reject(new Error("Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication")));
		await expect(embedTexts(endpoint, ["x"], { apiKey: undefined, env, vertexClient: noCreds })).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
		const down = fakeClient(() => Promise.reject(new Error("socket hang up")));
		await expect(embedTexts(endpoint, ["x"], { apiKey: undefined, env, vertexClient: down })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
	});

	it("rejects a malformed vector", async () => {
		const client = fakeClient(() => ({ embeddings: [{ values: [Number.NaN] }] }));
		await expect(embedTexts(endpoint, ["x"], { apiKey: undefined, env, vertexClient: client })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: expect.stringContaining("malformed") });
		const empty = fakeClient(() => ({ embeddings: [] }));
		await expect(embedTexts(endpoint, ["x"], { apiKey: undefined, env, vertexClient: empty })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: expect.stringContaining("malformed") });
	});

	it("times out a hung request and passes the abort signal on", async () => {
		const client = fakeClient(() => new Promise<EmbedContentResponse>(() => {}));
		await expect(embedTexts(endpoint, ["x"], { apiKey: undefined, env, vertexClient: client, timeoutMs: 100 })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
		expect(client.calls[0]?.config?.abortSignal?.aborted).toBe(true);
	});
});
