/** Float noise below this is not a drop. */
const EPSILON = 1e-9;

export interface HoldoutGate {
	/** True when the candidate must not be promoted. */
	regressed: boolean;
	/** Holdout mean before minus after (positive is worse). */
	meanDrop: number;
	/** Largest single-case drop (0 when no case got worse). */
	worstDrop: number;
}

/**
 * Verify-or-rollback check on the holdout split: a candidate regresses when its holdout mean is lower than the base's,
 * or when any one case drops by more than `maxCaseDrop`. A case with no score after counts as 0.
 */
export function holdoutRegression(
	before: Readonly<Record<string, { quality: number } | undefined>>,
	after: Readonly<Record<string, { quality: number } | undefined>>,
	ids: readonly string[],
	maxCaseDrop: number,
): HoldoutGate {
	if (ids.length === 0) return { regressed: false, meanDrop: 0, worstDrop: 0 };
	let sumDrop = 0;
	let worstDrop = 0;
	for (const id of ids) {
		const drop = (before[id]?.quality ?? 0) - (after[id]?.quality ?? 0);
		sumDrop += drop;
		worstDrop = Math.max(worstDrop, drop);
	}
	const meanDrop = sumDrop / ids.length;
	return { regressed: meanDrop > EPSILON || worstDrop > maxCaseDrop + EPSILON, meanDrop, worstDrop };
}
