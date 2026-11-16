import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { Semaphore } from "./semaphore.ts";

/** Returns the API key to send for a provider, or undefined to let pi-ai resolve credentials itself. */
export type ApiKeyResolver = (provider: string) => string | undefined;

/** Request metadata a provider reads from the config, by provider id (for example kiro-p's session reuse switch). */
export type ProviderMetadata = (provider: string) => Record<string, unknown> | undefined;

/**
 * Wraps Models.streamSimple so each provider never exceeds its configured number of concurrent requests. When the
 * request carries no `apiKey`, the key from `resolveApiKey` is passed as the request's `apiKey` option, and
 * `metadataFor`'s entries are added under the request's own `metadata`.
 */
export function createGatedStreamFn(models: Models, limits: Record<string, number | undefined>, resolveApiKey?: ApiKeyResolver, metadataFor?: ProviderMetadata): StreamFn {
	const semaphores = new Map<string, Semaphore>();
	const semaphoreFor = (provider: string): Semaphore | undefined => {
		const limit = limits[provider];
		if (limit === undefined) return undefined;
		let sem = semaphores.get(provider);
		if (!sem) {
			sem = new Semaphore(limit);
			semaphores.set(provider, sem);
		}
		return sem;
	};

	return async (model, context, options) => {
		const sem = semaphoreFor(model.provider);
		const release = sem ? await sem.acquire(options?.signal) : () => {};
		try {
			const apiKey = options?.apiKey ?? resolveApiKey?.(model.provider);
			const metadata = metadataFor?.(model.provider);
			const stream = models.streamSimple(
				model,
				context,
				apiKey === undefined && !metadata ? options : { ...options, ...(apiKey === undefined ? {} : { apiKey }), ...(metadata ? { metadata: { ...metadata, ...options?.metadata } } : {}) },
			);
			stream.result().then(release, release);
			return stream;
		} catch (error) {
			release();
			throw error;
		}
	};
}
