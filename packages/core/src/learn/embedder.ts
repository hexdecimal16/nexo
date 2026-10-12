import { ApiError, type EmbedContentParameters, type EmbedContentResponse, GoogleGenAI } from "@google/genai";
import { NexoError } from "@nexo/telemetry";
import type { NexoConfig } from "../config/schema.ts";

/** OpenAI's API root, used when `models.embedding.provider` is `openai` and no `baseUrl` is set. */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
/** The embedding provider served by the Vertex AI API with Google credentials (a service account or ADC) instead of a `baseUrl`. */
export const VERTEX_PROVIDER = "google-vertex";
/** Most Vertex embedding requests in flight at once; each request carries one text. */
const VERTEX_CONCURRENCY = 8;
/** Longest wait for one embeddings request. */
export const EMBED_TIMEOUT_MS = 30_000;

export interface EmbeddingEndpoint {
	provider: string;
	id: string;
	/** `provider/id`: the model key stored with each vector. */
	model: string;
	baseUrl: string;
	dimensions?: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The part of the `@google/genai` client the Vertex embedder uses. */
export interface VertexEmbedClient {
	models: { embedContent(params: EmbedContentParameters): Promise<EmbedContentResponse> };
}

export interface EmbedResult {
	vectors: number[][];
	/** Input tokens the provider reported; ceil(input chars / 4) when the reply carries no usage. 0 only for an empty input. */
	tokens: number;
	/** True when `tokens` is the chars/4 estimate because the reply reported no usage. */
	tokensEstimated?: true;
}

/** The configured embedding endpoint, or null without `models.embedding`. */
export function embeddingEndpoint(config: NexoConfig): EmbeddingEndpoint | null {
	const e = config.models.embedding;
	if (!e) return null;
	const baseUrl = e.provider === VERTEX_PROVIDER ? "" : (e.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
	return { provider: e.provider, id: e.id, model: `${e.provider}/${e.id}`, baseUrl, ...(e.dimensions ? { dimensions: e.dimensions } : {}) };
}

/** The reflector and curator model: `models.reflector`, where `{ ref }` (and an absent value, which means `{ ref: "s1" }`) names a role. */
export function reflectorModelSpec(config: NexoConfig): { provider: string; id: string; effort?: string } {
	const r = config.models.reflector;
	if (!r || ("ref" in r && r.ref === "s1")) return config.models.s1;
	if ("ref" in r) return config.models.s2;
	return r;
}

function providerError(endpoint: EmbeddingEndpoint, status: number, detail: string): NexoError {
	const context = { provider: endpoint.provider, model: endpoint.model, status };
	if (status === 401 || status === 403) {
		return new NexoError({ code: "PROVIDER_AUTH", message: `The embeddings endpoint refused the key (HTTP ${status})`, hint: `Check the key with \`nexo settings set-key ${endpoint.provider}\``, context });
	}
	if (status === 429) return new NexoError({ code: "PROVIDER_RATE_LIMIT", message: "The embeddings endpoint is rate limiting (HTTP 429)", retryable: true, context });
	if (status >= 500) return new NexoError({ code: "PROVIDER_UNAVAILABLE", message: `The embeddings endpoint failed (HTTP ${status})`, retryable: true, context });
	return new NexoError({ code: "PROVIDER_UNAVAILABLE", message: `The embeddings endpoint rejected the request (HTTP ${status}): ${detail.slice(0, 300)}`, context });
}

function isEmbedding(value: unknown): value is number[] {
	return Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === "number" && Number.isFinite(x));
}

function tokensOrEstimate(vectors: number[][], tokens: number, texts: readonly string[]): EmbedResult {
	if (Number.isFinite(tokens) && tokens > 0) return { vectors, tokens };
	const chars = texts.reduce((sum, t) => sum + t.length, 0);
	return { vectors, tokens: Math.ceil(chars / 4), tokensEstimated: true };
}

/** Vertex clients by project, location and key, so the Google auth client and its access token are reused across calls. */
const vertexClients = new Map<string, VertexEmbedClient>();

function vertexClient(project: string, location: string, apiKey: string | undefined): VertexEmbedClient {
	const key = `${project}\0${location}\0${apiKey ?? ""}`;
	let client = vertexClients.get(key);
	if (!client) {
		client = new GoogleGenAI({ vertexai: true, project, location, ...(apiKey ? { apiKey } : {}) });
		vertexClients.set(key, client);
	}
	return client;
}

/** A failure from the Vertex client, mapped like an HTTP failure; missing Google credentials are PROVIDER_AUTH. */
function vertexError(endpoint: EmbeddingEndpoint, error: unknown): NexoError {
	if (error instanceof NexoError) return error;
	if (error instanceof ApiError) return providerError(endpoint, error.status, error.message);
	const message = error instanceof Error ? error.message : String(error);
	if (/default credentials|GOOGLE_APPLICATION_CREDENTIALS|invalid_grant|unauthorized_client/i.test(message)) {
		return new NexoError({
			code: "PROVIDER_AUTH",
			message: "No usable Google credentials for Vertex AI embeddings",
			hint: "Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON file, or run `gcloud auth application-default login`",
			context: { provider: endpoint.provider, model: endpoint.model },
		});
	}
	return new NexoError({ code: "PROVIDER_UNAVAILABLE", message: `Vertex AI embeddings failed: ${message.slice(0, 300)}`, retryable: true, context: { model: endpoint.model }, cause: error });
}

/**
 * Embeds `texts` through the Vertex AI API, one request per text (Vertex embedding models take one input per request).
 * Authenticates with `apiKey` when set, else Google Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`
 * or gcloud); the project and location come from `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) and `GOOGLE_CLOUD_LOCATION`.
 */
async function embedVertex(
	endpoint: EmbeddingEndpoint,
	texts: readonly string[],
	options: { apiKey: string | undefined; env?: NodeJS.ProcessEnv; vertexClient?: VertexEmbedClient; signal?: AbortSignal; timeoutMs?: number },
): Promise<EmbedResult> {
	const env = options.env ?? process.env;
	const project = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
	const location = env.GOOGLE_CLOUD_LOCATION;
	if (!project || !location) {
		const missing = !project ? "GOOGLE_CLOUD_PROJECT" : "GOOGLE_CLOUD_LOCATION";
		throw new NexoError({
			code: "PROVIDER_AUTH",
			message: `Vertex AI embeddings need ${missing}`,
			hint: `Set ${missing} (and GOOGLE_APPLICATION_CREDENTIALS for a service account) in the environment nexo runs in`,
			context: { provider: endpoint.provider },
		});
	}
	const client = options.vertexClient ?? vertexClient(project, location, options.apiKey);
	const timeout = AbortSignal.timeout(options.timeoutMs ?? EMBED_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const aborted = new Promise<never>((_, reject) => {
		const fail = () => reject(signal.reason);
		if (signal.aborted) fail();
		else signal.addEventListener("abort", fail, { once: true });
	});
	aborted.catch(() => {});
	const embedOne = async (text: string): Promise<{ vector: number[]; tokens: number }> => {
		const config = { abortSignal: signal, ...(endpoint.dimensions ? { outputDimensionality: endpoint.dimensions } : {}) };
		let response: EmbedContentResponse;
		try {
			response = await Promise.race([client.models.embedContent({ model: endpoint.id, contents: text, config }), aborted]);
		} catch (error) {
			if (options.signal?.aborted) throw error;
			if (timeout.aborted) throw new NexoError({ code: "PROVIDER_TIMEOUT", message: "The embeddings request timed out", retryable: true, context: { model: endpoint.model } });
			throw vertexError(endpoint, error);
		}
		const embedding = response.embeddings?.length === 1 ? response.embeddings[0] : undefined;
		if (!isEmbedding(embedding?.values)) {
			throw new NexoError({ code: "PROVIDER_UNAVAILABLE", message: "The embeddings reply has a malformed vector", context: { model: endpoint.model } });
		}
		return { vector: embedding.values, tokens: Number(embedding.statistics?.tokenCount ?? 0) };
	};
	const results: { vector: number[]; tokens: number }[] = [];
	for (let start = 0; start < texts.length; start += VERTEX_CONCURRENCY) {
		results.push(...(await Promise.all(texts.slice(start, start + VERTEX_CONCURRENCY).map(embedOne))));
	}
	const reported = results.every((r) => Number.isFinite(r.tokens) && r.tokens > 0);
	return tokensOrEstimate(results.map((r) => r.vector), reported ? results.reduce((n, r) => n + r.tokens, 0) : 0, texts);
}

/**
 * Embeds `texts` with one `POST {baseUrl}/embeddings` request (OpenAI wire format), or through the Vertex AI API for
 * provider `google-vertex`. Throws PROVIDER_AUTH (no key or Google credentials, 401, 403), PROVIDER_RATE_LIMIT (429),
 * PROVIDER_UNAVAILABLE (5xx, network error, malformed reply) or PROVIDER_TIMEOUT. The key is sent only in the
 * Authorization header and never appears in an error.
 */
export async function embedTexts(
	endpoint: EmbeddingEndpoint,
	texts: readonly string[],
	options: {
		apiKey: string | undefined;
		fetch?: FetchLike;
		signal?: AbortSignal;
		timeoutMs?: number;
		/** Environment for the Vertex project and location; defaults to `process.env`. */
		env?: NodeJS.ProcessEnv;
		/** Replaces the `@google/genai` client for `google-vertex`. */
		vertexClient?: VertexEmbedClient;
	},
): Promise<EmbedResult> {
	if (texts.length === 0) return { vectors: [], tokens: 0 };
	if (endpoint.provider === VERTEX_PROVIDER) return embedVertex(endpoint, texts, options);
	if (!options.apiKey) {
		throw new NexoError({
			code: "PROVIDER_AUTH",
			message: `No API key for the embedding provider "${endpoint.provider}"`,
			hint: `Set it with \`nexo settings set-key ${endpoint.provider}\` or its environment variable`,
			context: { provider: endpoint.provider },
		});
	}
	const doFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
	const timeout = AbortSignal.timeout(options.timeoutMs ?? EMBED_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await doFetch(`${endpoint.baseUrl}/embeddings`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
			body: JSON.stringify({ model: endpoint.id, input: texts, ...(endpoint.dimensions ? { dimensions: endpoint.dimensions } : {}) }),
			signal,
		});
	} catch (cause) {
		if (options.signal?.aborted) throw cause;
		if (timeout.aborted) throw new NexoError({ code: "PROVIDER_TIMEOUT", message: "The embeddings request timed out", retryable: true, context: { model: endpoint.model } });
		throw new NexoError({ code: "PROVIDER_UNAVAILABLE", message: `The embeddings endpoint is unreachable: ${(cause as Error).message}`, retryable: true, context: { model: endpoint.model }, cause });
	}
	const body = await response.text();
	if (!response.ok) throw providerError(endpoint, response.status, body);
	let parsed: { data?: { index?: unknown; embedding?: unknown }[]; usage?: { prompt_tokens?: unknown; total_tokens?: unknown } };
	try {
		parsed = JSON.parse(body) as typeof parsed;
	} catch {
		throw new NexoError({ code: "PROVIDER_UNAVAILABLE", message: "The embeddings reply is not JSON", context: { model: endpoint.model } });
	}
	const data = Array.isArray(parsed.data) ? parsed.data : [];
	const slots: (number[] | undefined)[] = new Array(texts.length).fill(undefined);
	for (const [position, item] of data.entries()) {
		const index = typeof item.index === "number" ? item.index : position;
		const embedding = item.embedding;
		if (
			!isEmbedding(embedding) ||
			!Number.isInteger(index) ||
			index < 0 ||
			index >= texts.length ||
			slots[index] !== undefined
		) {
			throw new NexoError({ code: "PROVIDER_UNAVAILABLE", message: "The embeddings reply has a malformed vector", context: { model: endpoint.model, index } });
		}
		slots[index] = embedding;
	}
	const vectors: number[][] = [];
	for (const v of slots) if (v !== undefined) vectors.push(v);
	if (data.length !== texts.length || vectors.length !== texts.length) {
		throw new NexoError({ code: "PROVIDER_UNAVAILABLE", message: `The embeddings reply has ${data.length} vectors for ${texts.length} texts`, context: { model: endpoint.model } });
	}
	return tokensOrEstimate(vectors, Number(parsed.usage?.prompt_tokens ?? parsed.usage?.total_tokens ?? 0), texts);
}

/**
 * USD of an embeddings call from `pricingOverrides["<provider>/<id>"].input` (USD per million tokens). Without a price
 * the cost is unknown (spec §10: never counted as $0); only a call with no tokens (empty input) costs a known 0.
 */
export function embeddingCost(config: NexoConfig, endpoint: EmbeddingEndpoint, tokens: number): { costUsd: number; costUnknown: boolean } {
	const rate = config.pricingOverrides[endpoint.model]?.input;
	if (rate === undefined) return { costUsd: 0, costUnknown: tokens > 0 };
	return { costUsd: (tokens * rate) / 1_000_000, costUnknown: false };
}

/** Upper-bound USD of embedding `chars` characters (ceil(chars / 4) tokens); 0 without a price. */
export function estimateEmbeddingUsd(config: NexoConfig, endpoint: EmbeddingEndpoint, chars: number): number {
	const rate = config.pricingOverrides[endpoint.model]?.input;
	return rate === undefined ? 0 : (Math.ceil(chars / 4) * rate) / 1_000_000;
}
