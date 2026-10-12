/** A seeded random source returning numbers in [0, 1). */
export type Rng = () => number;

/** mulberry32: a small, fast, seedable generator; the same seed always yields the same sequence. */
export function mulberry32(seed: number): Rng {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Up to `n` distinct items in random order (a partial Fisher–Yates shuffle of a copy). */
export function sampleWithoutReplacement<T>(items: readonly T[], n: number, rng: Rng): T[] {
	const pool = [...items];
	const count = Math.min(Math.max(0, n), pool.length);
	for (let i = 0; i < count; i++) {
		const j = i + Math.floor(rng() * (pool.length - i));
		[pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
	}
	return pool.slice(0, count);
}

/** One item picked with probability proportional to its weight (weights must be >= 0 and not all 0). */
export function pickWeighted<T>(items: readonly T[], weights: readonly number[], rng: Rng): T {
	const total = weights.reduce((sum, w) => sum + w, 0);
	if (items.length === 0 || !(total > 0)) throw new RangeError("pickWeighted needs at least one item with a positive weight");
	let r = rng() * total;
	for (let i = 0; i < items.length; i++) {
		r -= weights[i] ?? 0;
		if (r < 0) return items[i] as T;
	}
	return items[items.length - 1] as T;
}
