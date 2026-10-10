/** Counting semaphore with FIFO waiters. `acquire` resolves to an idempotent release function. */
export class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(size: number) {
		if (!Number.isInteger(size) || size < 1) throw new RangeError(`Semaphore size must be a positive integer, got ${size}`);
		this.available = size;
	}

	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.available > 0) {
			this.available--;
			return Promise.resolve(this.releaser());
		}
		return new Promise((resolve, reject) => {
			const grant = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve(this.releaser());
			};
			const onAbort = () => {
				const index = this.waiters.indexOf(grant);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(signal?.reason);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.push(grant);
		});
	}

	private releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			if (next) next();
			else this.available++;
		};
	}
}
