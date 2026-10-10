// Display formatting with no locale or time-zone dependence, so output is identical in tests and browsers.

export function formatUsd(usd: number, unknown = false): string {
	const value = `$${(Number.isFinite(usd) ? usd : 0).toFixed(4)}`;
	return unknown ? `${value} + unpriced` : value;
}

export function formatDuration(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms < 0) return "–";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Milliseconds from start to end, or to `nowMs` while the span or run is still open. */
export function durationMs(startIso: string, endIso: string | null, nowMs: number): number {
	const start = Date.parse(startIso);
	const end = endIso === null ? nowMs : Date.parse(endIso);
	return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

/** `2026-10-10T10:00:00.000Z` → `2026-10-10 10:00:00` (UTC). */
export function formatTime(iso: string | null): string {
	return iso ? iso.replace("T", " ").slice(0, 19) : "–";
}

export function shortId(id: string): string {
	return id.slice(-6);
}

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
