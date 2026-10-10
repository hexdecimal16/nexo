import { NexoError } from "@nexo/telemetry";
import { canonicalPath } from "./confine.ts";

/**
 * Per-file write ownership shared by all runs in one run tree. A holder keeps its leases until releaseAll.
 * Keys are canonical paths, so `/var/...` and `/private/var/...` spellings of one file share a lease.
 *
 * Runs in one ancestor line never execute at the same time in a conflicting way (a parent waits on its children), so
 * a file may be held by several runs at once as long as each pair is ancestor and descendant. Holders that could run
 * concurrently, such as siblings, conflict.
 */
export class FileLeases {
	private readonly holders = new Map<string, string[]>();
	private readonly parents = new Map<string, string>();

	/** Records that run `child` was started by run `parent`. */
	link(child: string, parent: string): void {
		this.parents.set(child, parent);
	}

	acquire(path: string, holder: string): void {
		const key = canonicalPath(path);
		const current = this.holders.get(key) ?? [];
		const conflicting = current.find((other) => other !== holder && !this.related(other, holder));
		if (conflicting !== undefined) {
			throw new NexoError({
				code: "WRITE_CONFLICT",
				message: `File ${key} is being written by another task (${conflicting})`,
				retryable: true,
				hint: "Retry after the other task finishes, or write to a different file",
				context: { path: key, holder: conflicting },
			});
		}
		if (!current.includes(holder)) this.holders.set(key, [...current, holder]);
	}

	releaseAll(holder: string): void {
		for (const [path, owners] of this.holders) {
			const rest = owners.filter((owner) => owner !== holder);
			if (rest.length === 0) this.holders.delete(path);
			else this.holders.set(path, rest);
		}
	}

	/** The first run that acquired the file among those still holding it. */
	holderOf(path: string): string | undefined {
		return this.holders.get(canonicalPath(path))?.[0];
	}

	private related(a: string, b: string): boolean {
		return this.isAncestor(a, b) || this.isAncestor(b, a);
	}

	private isAncestor(ancestor: string, run: string): boolean {
		for (let current = this.parents.get(run); current !== undefined; current = this.parents.get(current)) {
			if (current === ancestor) return true;
		}
		return false;
	}
}
