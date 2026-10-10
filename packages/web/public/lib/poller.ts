// One polling loop for the run page. `refresh()` can be called at any time (a poll tick, a saved verdict): it cancels
// the pending tick, joins a refresh already in flight instead of starting a second one, and schedules at most one
// next tick. A failed refresh while polling retries with exponential backoff. Timers are injected, so this module
// stays free of DOM APIs and is tested under vitest.

/** Milliseconds between refreshes of a run that is still running. */
export const POLL_MS = 3000;

/** Longest wait between retries after failed refreshes. */
export const MAX_POLL_BACKOFF_MS = 30_000;

/** Delay before the next refresh: POLL_MS while healthy, doubling per consecutive failure up to MAX_POLL_BACKOFF_MS. */
export function pollDelay(failures: number, intervalMs: number = POLL_MS, maxMs: number = MAX_POLL_BACKOFF_MS): number {
	return Math.min(maxMs, intervalMs * 2 ** Math.max(0, failures));
}

export interface PollerOptions {
	/** Loads and renders once; resolves true while the run is still running (keep polling). */
	task: () => Promise<boolean>;
	onError: (error: unknown) => void;
	setTimer: (callback: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
	intervalMs?: number;
	maxBackoffMs?: number;
}

export interface Poller {
	refresh(): Promise<void>;
}

export function createPoller(options: PollerOptions): Poller {
	let timer: unknown = null;
	let inFlight: Promise<void> | null = null;
	let again = false;
	let polling = false;
	let failures = 0;

	const schedule = (ms: number): void => {
		timer = options.setTimer(() => {
			timer = null;
			void refresh();
		}, ms);
	};

	const runOnce = async (): Promise<void> => {
		do {
			again = false;
			try {
				polling = await options.task();
				failures = 0;
			} catch (error) {
				failures++;
				try {
					options.onError(error);
				} catch {
					// A failing error handler must not end the loop.
				}
			}
		} while (again);
		// Cleared in the same synchronous step as the schedule, so a refresh() can never see a finished loop as in flight.
		inFlight = null;
		if (polling) schedule(pollDelay(failures, options.intervalMs, options.maxBackoffMs));
	};

	const refresh = (): Promise<void> => {
		if (timer !== null) {
			options.clearTimer(timer);
			timer = null;
		}
		if (inFlight) {
			again = true;
			return inFlight;
		}
		inFlight = runOnce();
		return inFlight;
	};

	return { refresh };
}
