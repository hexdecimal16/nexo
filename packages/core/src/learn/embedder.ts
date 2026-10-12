import { NexoError } from "@nexo/telemetry";
import type { NexoConfig } from "../config/schema.ts";

/** OpenAI's API root, used when `models.embedding.provider` is `openai` and no `baseUrl` is set. */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
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
	const baseUrl = (e.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
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

/**
 * Embeds `texts` with one `POST {baseUrl}/embeddings` request (OpenAI wire format). Throws PROVIDER_AUTH (no key, 401,
 * 403), PROVIDER_RATE_LIMIT (429), PROVIDER_UNAVAILABLE (5xx, network error, malformed reply) or PROVIDER_TIMEOUT. The key
 * is sent only in the Authorization header and never appears in an error.
 */
export async function embedTexts(
	endpoint: EmbeddingEndpoint,
	texts: readonly string[],
	options: { apiKey: string | undefined; fetch?: FetchLike; signal?: AbortSignal; timeoutMs?: number },
): Promise<EmbedResult> {
	if (texts.length === 0) return { vectors: [], tokens: 0 };
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
			!Array.isArray(embedding) ||
			embedding.length === 0 ||
			!embedding.every((x) => typeof x === "number" && Number.isFinite(x)) ||
			!Number.isInteger(index) ||
			index < 0 ||
			index >= texts.length ||
			slots[index] !== undefined
		) {
			throw new NexoError({ code: "PROVIDER_UNAVAILABLE", message: "The embeddings reply has a malformed vector", context: { model: endpoint.model, index } });
		}
		slots[index] = embedding as number[];
	}
	const vectors: number[][] = [];
	for (const v of slots) if (v !== undefined) vectors.push(v);
	if (data.length !== texts.length || vectors.length !== texts.length) {
		throw new NexoError({ code: "PROVIDER_UNAVAILABLE", message: `The embeddings reply has ${data.length} vectors for ${texts.length} texts`, context: { model: endpoint.model } });
	}
	const tokens = Number(parsed.usage?.prompt_tokens ?? parsed.usage?.total_tokens ?? 0);
	if (Number.isFinite(tokens) && tokens > 0) return { vectors, tokens };
	const chars = texts.reduce((sum, t) => sum + t.length, 0);
	return { vectors, tokens: Math.ceil(chars / 4), tokensEstimated: true };
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
