import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { Semaphore } from "./semaphore.ts";

/** Returns the API key to send for a provider, or undefined to let pi-ai resolve credentials itself. */
export type ApiKeyResolver = (provider: string) => string | undefined;

/**
 * Wraps Models.streamSimple so each provider never exceeds its configured number of concurrent requests. When the
 * request carries no `apiKey`, the key from `resolveApiKey` is passed as the request's `apiKey` option.
 */
export function createGatedStreamFn(models: Models, limits: Record<string, number | undefined>, resolveApiKey?: ApiKeyResolver): StreamFn {
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
			const stream = models.streamSimple(model, context, apiKey === undefined ? options : { ...options, apiKey });
			stream.result().then(release, release);
			return stream;
		} catch (error) {
			release();
			throw error;
		}
	};
}
