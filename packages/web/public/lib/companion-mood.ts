// nex, the nexo companion: turns the most recent runs into a mood and a one-line remark. Pure, so it is tested under
// vitest; pages/companion.ts draws the character and wires the quick actions.
import type { RunSummary } from "./api-types.ts";

export type Mood = "working" | "happy" | "worried" | "idle" | "sleepy";

export interface CompanionState {
	mood: Mood;
	line: string;
	running: RunSummary[];
	latest: RunSummary | null;
	lastFailed: RunSummary | null;
}

const FAILED = new Set(["failed", "error", "aborted", "budget_exceeded"]);
const MIN = 60_000;
/** A failure this recent keeps nex worried. */
export const WORRY_MS = 60 * MIN;
/** A success this recent keeps nex happy. */
export const HAPPY_MS = 15 * MIN;
/** No activity for this long and nex dozes off. */
export const SLEEP_MS = 3 * 60 * MIN;

/** Mouth path for each mood, in the character's 64x64 viewBox. */
export const MOUTHS: Record<Mood, string> = {
	happy: "M24 40 Q32 48 40 40",
	idle: "M26 41 Q32 44.5 38 41",
	worried: "M25 44 Q32 38 39 44",
	working: "M28 42 L36 42",
	sleepy: "M29 42 Q32 43.5 35 42",
};

export function isFailed(status: string): boolean {
	return FAILED.has(status);
}

export function ago(ms: number): string {
	if (ms < MIN) return "just now";
	if (ms < 60 * MIN) return `${Math.floor(ms / MIN)}m ago`;
	if (ms < 48 * 60 * MIN) return `${Math.floor(ms / (60 * MIN))}h ago`;
	return `${Math.floor(ms / (24 * 60 * MIN))}d ago`;
}

function clip(text: string, max = 48): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function endMs(run: RunSummary): number {
	return Date.parse(run.endedAt ?? run.startedAt) || 0;
}

export function deriveMood(runs: RunSummary[], nowMs: number): CompanionState {
	const running = runs.filter((r) => r.status === "running");
	const finished = runs.filter((r) => r.status !== "running").sort((a, b) => endMs(b) - endMs(a));
	const latest = finished[0] ?? null;
	const lastFailed = finished.find((r) => isFailed(r.status)) ?? null;
	const base = { running, latest, lastFailed };

	if (running.length === 1 && running[0]) return { ...base, mood: "working", line: `On it: “${clip(running[0].instruction)}”` };
	if (running.length > 1) return { ...base, mood: "working", line: `Juggling ${running.length} runs at once.` };
	if (!latest) return { ...base, mood: "sleepy", line: "No runs yet. Start one with nexo and I'll keep watch." };

	const since = Math.max(0, nowMs - endMs(latest));
	const word = latest.status.replace("_", " ");
	if (isFailed(latest.status) && since < WORRY_MS) return { ...base, mood: "worried", line: `“${clip(latest.instruction)}” ${word} ${ago(since)}. Want a look?` };
	if (latest.status === "succeeded" && since < HAPPY_MS) return { ...base, mood: "happy", line: `Done: “${clip(latest.instruction)}” (${ago(since)}).` };
	if (since >= SLEEP_MS) return { ...base, mood: "sleepy", line: `Quiet since ${ago(since)}. Napping until the next run.` };
	return { ...base, mood: "idle", line: `All calm. Last run ${word} ${ago(since)}.` };
}

/** Runs that were running last poll and have now finished, split by outcome; drives nex's cheer and flinch. */
export function transitions(previousRunning: ReadonlySet<string>, runs: RunSummary[]): { succeeded: number; failed: number } {
	let succeeded = 0;
	let failed = 0;
	for (const run of runs) {
		if (!previousRunning.has(run.id) || run.status === "running") continue;
		if (run.status === "succeeded") succeeded++;
		else if (isFailed(run.status)) failed++;
	}
	return { succeeded, failed };
}
