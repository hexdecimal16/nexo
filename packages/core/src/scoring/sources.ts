import { readFileSync } from "node:fs";
import { DEFAULT_ROUTER_POLICY, parseRouterPolicy, type RouterPolicy } from "@nexo/router";
import { DEFAULT_JUDGE_RUBRIC, type ModelRef, modelKeyOf, sameFamilyPairs } from "@nexo/scorers";
import { type ArtifactRow, type Db, ensureManualArtifact, ensureSeedArtifact } from "@nexo/store";
import { NexoError, type Redactor } from "@nexo/telemetry";
import type { NexoConfig } from "../config/schema.ts";

/** Artifact name of the router policy and judge rubric that `artifact:` sources and `file:` sources both use. */
export const DEFAULT_ARTIFACT_NAME = "default";

function readSource(path: string, key: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (cause) {
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: `Cannot read ${path} (${key}): ${(cause as Error).message}`,
			hint: `Point ${key} at an existing file, or set it to its artifact: default`,
			context: { key, path },
			cause,
		});
	}
}

/**
 * The run's router policy and the artifact version it came from. `artifact:router_policy` uses the active version,
 * seeding version 1 with DEFAULT_ROUTER_POLICY; `file:<path>` stores the file (redacted) as a new manual version when it
 * changed.
 * Throws CONFIG_INVALID for an unreadable file or an invalid policy.
 */
export function loadRouterPolicy(db: Db, config: NexoConfig, nowIso: string, redact: Redactor): { policy: RouterPolicy; artifact: ArtifactRow } {
	const source = config.router.policy;
	let artifact: ArtifactRow;
	if (source.startsWith("file:")) {
		const text = readSource(source.slice("file:".length), "router.policy");
		parseRouterPolicy(text, source);
		artifact = ensureManualArtifact(db, "router_policy", DEFAULT_ARTIFACT_NAME, redact(text), nowIso);
	} else {
		artifact = ensureSeedArtifact(db, "router_policy", DEFAULT_ARTIFACT_NAME, `${JSON.stringify(DEFAULT_ROUTER_POLICY, null, 2)}\n`, nowIso);
	}
	return { policy: parseRouterPolicy(artifact.content, `router_policy v${artifact.version}`), artifact };
}

/** The generic judge rubric and its artifact version; `artifact:judge_rubric` seeds DEFAULT_JUDGE_RUBRIC. */
export function loadJudgeRubric(db: Db, config: NexoConfig, nowIso: string, redact: Redactor): { rubric: string; artifact: ArtifactRow } {
	const source = config.scoring.rubric;
	const artifact = source.startsWith("file:")
		? ensureManualArtifact(db, "judge_rubric", DEFAULT_ARTIFACT_NAME, redact(readSource(source.slice("file:".length), "scoring.rubric")), nowIso)
		: ensureSeedArtifact(db, "judge_rubric", DEFAULT_ARTIFACT_NAME, `${DEFAULT_JUDGE_RUBRIC}\n`, nowIso);
	if (!artifact.content.trim()) {
		throw new NexoError({ code: "CONFIG_INVALID", message: "The judge rubric is empty", hint: "Write grading criteria into the rubric file", context: { source } });
	}
	return { rubric: artifact.content, artifact };
}

/** The configured judge models (`models.judge`); empty when no judge is configured. */
export function judgeModels(config: NexoConfig): ModelRef[] {
	return (config.models.judge ?? []).map((m) => ({ provider: m.provider, id: m.id }));
}

/** The judge key stored with judge scores and calibrations: model keys joined with `+`; null without a judge. */
export function judgeKey(config: NexoConfig): string | null {
	const models = judgeModels(config);
	return models.length === 0 ? null : models.map(modelKeyOf).join("+");
}

/** One warning per judge model from the same family as `models.s1` or `models.s2` (spec §7.4). */
export function judgeFamilyWarnings(config: NexoConfig): string[] {
	const generators = [config.models.s1, config.models.s2].map((m) => ({ provider: m.provider, id: m.id }));
	const byJudge = new Map<string, { family: string; generators: string[] }>();
	for (const p of sameFamilyPairs(judgeModels(config), generators)) {
		const entry = byJudge.get(p.judge) ?? { family: p.family, generators: [] };
		if (!entry.generators.includes(p.generator)) entry.generators.push(p.generator);
		byJudge.set(p.judge, entry);
	}
	return [...byJudge].map(
		([judge, e]) =>
			`Judge ${judge} is from the same model family (${e.family}) as ${e.generators.join(" and ")}; its verdicts may favour that model. Use a judge from another family in models.judge.`,
	);
}
