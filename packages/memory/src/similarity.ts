/** Cosine similarity at or above which two texts are the same note (spec §8.1). */
export const DEDUP_COSINE = 0.92;
/**
 * Word-set Jaccard similarity at or above which two texts are the same note when either has no embedding. 0.8 means
 * at most one word in five differs, so rephrasings with new content stay separate.
 */
export const DEDUP_JACCARD = 0.8;

/** Lowercase letter/digit runs of a text, as a set. */
export function words(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** |A ∩ B| / |A ∪ B| of the word sets; 1 for two texts without words. */
export function jaccard(a: string, b: string): number {
	const wa = words(a);
	const wb = words(b);
	if (wa.size === 0 && wb.size === 0) return 1;
	let shared = 0;
	for (const w of wa) if (wb.has(w)) shared++;
	return shared / (wa.size + wb.size - shared);
}

/** Cosine similarity; 0 when the lengths differ or either vector is all zeros. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = Number(a[i]);
		const y = Number(b[i]);
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (na === 0 || nb === 0) return 0;
	return dot / Math.sqrt(na * nb);
}

export interface Comparable {
	text: string;
	vector?: ArrayLike<number> | null;
}

/** Same note: cosine ≥ DEDUP_COSINE when both have vectors, else Jaccard ≥ DEDUP_JACCARD. */
export function isDuplicate(a: Comparable, b: Comparable): boolean {
	if (a.vector && b.vector && a.vector.length === b.vector.length) return cosine(a.vector, b.vector) >= DEDUP_COSINE;
	return jaccard(a.text, b.text) >= DEDUP_JACCARD;
}
