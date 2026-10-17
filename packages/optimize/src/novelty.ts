/** Similarity (0..1) at or above which a reflected text is a near-duplicate of a pool text and is rejected before any rollout. */
export const NOVELTY_MAX_SIMILARITY = 0.98;

/** Cosine similarity; 0 when the lengths differ or either vector is all zeros. */
export function textCosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
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

function wordSet(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Word-set Jaccard similarity: the fallback when the adapter has no embeddings. 1 for two texts without words. */
export function wordJaccard(a: string, b: string): number {
	const wa = wordSet(a);
	const wb = wordSet(b);
	if (wa.size === 0 && wb.size === 0) return 1;
	let shared = 0;
	for (const w of wa) if (wb.has(w)) shared++;
	return shared / (wa.size + wb.size - shared);
}

/** Word-overlap similarity at or above which a reflected text is a near-duplicate when no embeddings are available. */
export const NOVELTY_MAX_JACCARD = 0.98;
