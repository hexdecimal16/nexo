import { NexoError } from "@nexo/telemetry";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** Escalation triggers of spec §7.2. */
export const ESCALATION_TRIGGERS = ["tool_failures", "stagnation", "self_check", "verify_fail", "judge_low", "skill_hint"] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

const Toggle = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
const Threshold = Type.Number({ minimum: 0, maximum: 1 });

export const RouterPolicySchema = Type.Object(
	{
		triggers: Type.Object(
			{
				tool_failures: Type.Object({ enabled: Type.Boolean(), consecutive: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
				stagnation: Type.Object({ enabled: Type.Boolean(), turns: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
				self_check: Type.Object({ enabled: Type.Boolean(), threshold: Threshold }, { additionalProperties: false }),
				verify_fail: Toggle,
				judge_low: Type.Object({ enabled: Type.Boolean(), threshold: Threshold }, { additionalProperties: false }),
				skill_hint: Toggle,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type RouterPolicy = Static<typeof RouterPolicySchema>;

/**
 * The seed `router_policy` artifact. Defaults from spec §7.2, except `self_check`, which is off: it costs one more model
 * call on every run, and the judge and deterministic scorers cover the same end-of-run signal.
 */
export const DEFAULT_ROUTER_POLICY: RouterPolicy = {
	triggers: {
		tool_failures: { enabled: true, consecutive: 2 },
		stagnation: { enabled: true, turns: 3 },
		self_check: { enabled: false, threshold: 0.6 },
		verify_fail: { enabled: true },
		judge_low: { enabled: true, threshold: 0.6 },
		skill_hint: { enabled: true },
	},
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fills triggers, and fields of triggers, that `raw` leaves out with the defaults; anything malformed is kept for validation to report. */
function withDefaults(raw: unknown): unknown {
	if (!isObject(raw)) return raw;
	if (raw.triggers === undefined) return { ...raw, triggers: DEFAULT_ROUTER_POLICY.triggers };
	if (!isObject(raw.triggers)) return raw;
	const triggers: Record<string, unknown> = { ...raw.triggers };
	for (const name of ESCALATION_TRIGGERS) {
		const given = triggers[name];
		if (given === undefined) triggers[name] = DEFAULT_ROUTER_POLICY.triggers[name];
		else if (isObject(given)) triggers[name] = { ...DEFAULT_ROUTER_POLICY.triggers[name], ...given };
	}
	return { ...raw, triggers };
}

/**
 * Parses router-policy JSON. Triggers and fields left out take the defaults. Invalid JSON or values throw CONFIG_INVALID
 * naming each JSON path; `source` names where the text came from.
 */
export function parseRouterPolicy(text: string, source: string): RouterPolicy {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new NexoError({ code: "CONFIG_INVALID", message: `Router policy ${source} is not valid JSON`, hint: "Write a JSON object", context: { source } });
	}
	const policy = withDefaults(raw);
	if (!Value.Check(RouterPolicySchema, policy)) {
		const errors = [
			...new Set(
				[...Value.Errors(RouterPolicySchema, policy)]
					// typebox reports a property that additionalProperties: false rejects as a "boolean" (false-schema) error at that property's path
					.filter((e) => e.keyword !== "additionalProperties")
					.map((e) => `${e.instancePath || "/"} ${e.keyword === "boolean" ? "is not a recognized setting" : e.message}`),
			),
		];
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: `Invalid router policy ${source}:\n  ${errors.join("\n  ")}`,
			hint: `Triggers are ${ESCALATION_TRIGGERS.join(", ")}; each takes the fields of DEFAULT_ROUTER_POLICY`,
			context: { source, errors },
		});
	}
	return policy;
}

export interface EscalationSignal {
	trigger: EscalationTrigger;
	reason: string;
}

/** Counts the mid-run trigger conditions of one run: consecutive tool errors, stagnant turns and S2 skill hints. */
export class TriggerMonitor {
	private readonly policy: RouterPolicy;
	private consecutiveFailures = 0;
	private stagnantTurns = 0;
	private readonly seenResults = new Set<string>();

	constructor(policy: RouterPolicy) {
		this.policy = policy;
	}

	/** After each tool result. Fires when the configured number of consecutive tool errors is reached. */
	toolResult(isError: boolean): EscalationSignal | null {
		this.consecutiveFailures = isError ? this.consecutiveFailures + 1 : 0;
		const t = this.policy.triggers.tool_failures;
		if (!t.enabled || this.consecutiveFailures < t.consecutive) return null;
		const count = this.consecutiveFailures;
		this.consecutiveFailures = 0;
		return { trigger: "tool_failures", reason: `${count} consecutive tool calls failed` };
	}

	/**
	 * After each turn that ran tools, with one key per tool result (tool, arguments and result text). A turn whose keys
	 * were all seen before is stagnant; fires after the configured number of stagnant turns in a row. Turns without tool
	 * calls end the loop and are not counted.
	 */
	turnEnd(resultKeys: readonly string[]): EscalationSignal | null {
		if (resultKeys.length === 0) return null;
		let fresh = false;
		for (const key of resultKeys) {
			if (!this.seenResults.has(key)) fresh = true;
			this.seenResults.add(key);
		}
		this.stagnantTurns = fresh ? 0 : this.stagnantTurns + 1;
		const t = this.policy.triggers.stagnation;
		if (!t.enabled || this.stagnantTurns < t.turns) return null;
		const turns = this.stagnantTurns;
		this.stagnantTurns = 0;
		return { trigger: "stagnation", reason: `${turns} turns in a row produced no new tool result` };
	}

	/** When `load_skill` loads a skill into the conversation; fires for a skill that sets `nexo-model: s2`. */
	skillLoaded(name: string, skillModel: string | undefined): EscalationSignal | null {
		if (!this.policy.triggers.skill_hint.enabled || skillModel !== "s2") return null;
		return { trigger: "skill_hint", reason: `skill "${name}" sets nexo-model: s2` };
	}
}

export interface EndOfRunEvidence {
	/** The model's rating of its own answer (0..1), or null when no self-check ran. */
	selfCheck: number | null;
	/** Names of deterministic scorers that did not pass. */
	failedDeterministic: readonly string[];
	/** The judge score (0..1), or null when no judge scored the run. */
	judgeScore: number | null;
}

/** The end-of-run triggers that fire for this evidence, in spec order. */
export function endOfRunSignals(policy: RouterPolicy, evidence: EndOfRunEvidence): EscalationSignal[] {
	const out: EscalationSignal[] = [];
	const t = policy.triggers;
	if (t.self_check.enabled && evidence.selfCheck !== null && evidence.selfCheck < t.self_check.threshold) {
		out.push({ trigger: "self_check", reason: `self-check rated the answer ${evidence.selfCheck.toFixed(2)} (threshold ${t.self_check.threshold})` });
	}
	if (t.verify_fail.enabled && evidence.failedDeterministic.length > 0) {
		out.push({ trigger: "verify_fail", reason: `deterministic scorer${evidence.failedDeterministic.length === 1 ? "" : "s"} failed: ${evidence.failedDeterministic.join(", ")}` });
	}
	if (t.judge_low.enabled && evidence.judgeScore !== null && evidence.judgeScore < t.judge_low.threshold) {
		out.push({ trigger: "judge_low", reason: `judge score ${evidence.judgeScore.toFixed(2)} is below ${t.judge_low.threshold}` });
	}
	return out;
}

export type EscalationBlock = "skill_disabled" | "model_not_allowed" | "user_model" | "max_escalations" | "budget_cutoff";

/** Human-readable reason for each block, used in logs and on screen. */
export const ESCALATION_BLOCK_REASONS: Record<EscalationBlock, string> = {
	skill_disabled: 'the skill sets nexo-escalate: "false"',
	model_not_allowed: "model not allowed",
	user_model: "the user chose the model",
	max_escalations: "router.maxEscalations reached",
	budget_cutoff: "budgets.escalationCutoff reached",
};

export interface EscalationGate {
	/** Escalations that already took effect in this run. */
	escalations: number;
	maxEscalations: number;
	/** Share of the run budget spent so far (0..1+). */
	spentFraction: number;
	/** `budgets.escalationCutoff`. */
	cutoff: number;
	/** False when the run's skill sets `nexo-escalate: "false"`. */
	skillAllows: boolean;
	/** False when the escalation target is outside the run's skill `nexo-model-allowed` list. */
	modelAllowed: boolean;
	/** True when the user chose the model explicitly (`--model`, `/model` or a project pin). */
	userPinned: boolean;
}

/** Why an escalation may not happen now, or null when it may. */
export function escalationBlock(gate: EscalationGate): EscalationBlock | null {
	if (!gate.skillAllows) return "skill_disabled";
	if (!gate.modelAllowed) return "model_not_allowed";
	if (gate.userPinned) return "user_model";
	if (gate.escalations >= gate.maxEscalations) return "max_escalations";
	if (gate.spentFraction > gate.cutoff) return "budget_cutoff";
	return null;
}
