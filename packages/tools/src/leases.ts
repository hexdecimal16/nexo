import { NexoError } from "@nexo/telemetry";
import { canonicalPath } from "./confine.ts";

/**
 * Per-file write ownership shared by all runs in one run tree. A holder keeps its leases until releaseAll.
 * Keys are canonical paths, so `/var/...` and `/private/var/...` spellings of one file share a lease.
 */
export class FileLeases {
	private readonly holders = new Map<string, string>();

	acquire(path: string, holder: string): void {
		const key = canonicalPath(path);
		const current = this.holders.get(key);
		if (current !== undefined && current !== holder) {
			throw new NexoError({
				code: "WRITE_CONFLICT",
				message: `File ${key} is being written by another task (${current})`,
				retryable: true,
				hint: "Retry after the other task finishes, or write to a different file",
				context: { path: key, holder: current },
			});
		}
		this.holders.set(key, holder);
	}

	releaseAll(holder: string): void {
		for (const [path, owner] of this.holders) if (owner === holder) this.holders.delete(path);
	}

	holderOf(path: string): string | undefined {
		return this.holders.get(canonicalPath(path));
	}
}
