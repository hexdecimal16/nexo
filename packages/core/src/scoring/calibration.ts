import {
	agreementStats,
	type CalibrationRow,
	type ConfusionMatrix,
	confusionMatrix,
	type Db,
	type Disagreement,
	judgeHumanPairs,
	listDisagreements,
	recordCalibration,
	syncJudgeDisagreement,
} from "@nexo/store";
import { NexoError } from "@nexo/telemetry";
import type { NexoConfig } from "../config/schema.ts";
import { judgeFamilyWarnings, judgeKey } from "./sources.ts";

export interface JudgeCalibrationReport {
	judgeKey: string;
	/** The stored result; null when no run has both a judge score by this judge and a human verdict (nothing is stored). */
	calibration: CalibrationRow | null;
	matrix: ConfusionMatrix;
	disagreements: Disagreement[];
	/** Same-family warnings for the configured judge. */
	warnings: string[];
}

/**
 * `nexo eval judge` (spec §7.4): compares the judge's verdicts with human verdicts on the runs that have both, stores
 * accuracy and Cohen's κ, and lists the disagreements. `judgeKey` defaults to the configured `models.judge`. Throws
 * CONFIG_INVALID when no judge is configured and none is named.
 */
export function calibrateJudge(db: Db, config: NexoConfig, options: { judgeKey?: string; nowIso: string }): JudgeCalibrationReport {
	const key = options.judgeKey ?? judgeKey(config);
	if (!key) {
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: "No judge is configured",
			hint: 'Set models.judge in your nexo config, for example [{"provider":"google","id":"<model-id>"}], or pass --judge <provider/id>',
		});
	}
	const pairs = judgeHumanPairs(db, key);
	// Feedback sync only sees verdicts that existed when the human answered; this covers runs judged afterwards or reindexed.
	for (const pair of pairs) syncJudgeDisagreement(db, pair.runId, options.nowIso);
	const matrix = confusionMatrix(pairs);
	const calibration = agreementStats(matrix).cases > 0 ? recordCalibration(db, key, options.nowIso) : null;
	return {
		judgeKey: key,
		calibration,
		matrix,
		disagreements: listDisagreements(db, { judgeKey: key }),
		warnings: options.judgeKey === undefined ? judgeFamilyWarnings(config) : [],
	};
}
