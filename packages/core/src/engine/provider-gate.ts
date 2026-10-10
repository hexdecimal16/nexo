import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { Semaphore } from "./semaphore.ts";

/** Wraps Models.streamSimple so each provider never exceeds its configured number of concurrent requests. */
export function createGatedStreamFn(models: Models, limits: Record<string, number | undefined>): StreamFn {
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
		const stream = models.streamSimple(model, context, options);
		stream.result().then(release, release);
		return stream;
	};
}
