import { NexoError } from "@nexo/telemetry";
import type { Effort } from "./effort.ts";

export type Role = "s1" | "s2";
export type ModelSource = "user" | "parent" | "skill" | "default" | "router";

export interface RoleModel {
	provider: string;
	id: string;
	effort?: Effort;
}

export interface ModelChoice {
	model?: string;
	effort?: Effort;
}

export interface SkillModelPrefs {
	model?: string;
	effort?: Effort;
	allowed: readonly string[];
}

export interface ResolveModelInput {
	user?: ModelChoice;
	parent?: ModelChoice;
	skill?: SkillModelPrefs;
	roles: Record<Role, RoleModel>;
	remainingFraction: number;
	lowBudgetFraction?: number;
}

export interface ResolvedModel {
	provider: string;
	id: string;
	role: Role | null;
	effort: Effort;
	source: ModelSource;
	effortSource: ModelSource;
}

const DEFAULT_ALLOWED: readonly string[] = ["s1", "s2"];

/** Parses "s1" | "s2" | "provider/model-id" (the id may itself contain slashes). */
export function parseModelRef(ref: string, roles: Record<Role, RoleModel>): { provider: string; id: string; role: Role | null } {
	if (ref === "s1" || ref === "s2") return { provider: roles[ref].provider, id: roles[ref].id, role: ref };
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) {
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: `Model reference "${ref}" must be "s1", "s2" or "provider/model-id"`,
			context: { ref },
		});
	}
	const provider = ref.slice(0, slash);
	const id = ref.slice(slash + 1);
	const role = (["s1", "s2"] as const).find((r) => roles[r].provider === provider && roles[r].id === id) ?? null;
	return { provider, id, role };
}

function assertAllowed(ref: string, allowed: readonly string[], roles: Record<Role, RoleModel>): void {
	let wanted: { provider: string; id: string };
	try {
		wanted = parseModelRef(ref, roles);
	} catch (cause) {
		throw new NexoError({
			code: "MODEL_NOT_ALLOWED",
			message: `Model "${ref}" is not a valid model reference`,
			retryable: true,
			hint: 'Use "s1", "s2" or "provider/model-id"',
			cause,
		});
	}
	const ok = allowed.some((entry) => {
		if (entry === ref) return true;
		try {
			const p = parseModelRef(entry, roles);
			return p.provider === wanted.provider && p.id === wanted.id;
		} catch {
			return false;
		}
	});
	if (!ok) {
		throw new NexoError({
			code: "MODEL_NOT_ALLOWED",
			message: `Model "${ref}" is not allowed for this skill (allowed: ${allowed.join(", ")})`,
			retryable: true,
			hint: "Pick one of the allowed models, or omit model to use the skill default",
			context: { ref, allowed },
		});
	}
}

/** Model precedence: user > parent (allow-listed, budget-clamped) > skill > s1 default. Effort resolves on its own chain. */
export function resolveModel(input: ResolveModelInput): ResolvedModel {
	const low = input.lowBudgetFraction ?? 0.2;
	const allowed = input.skill?.allowed ?? DEFAULT_ALLOWED;
	let ref = "s1";
	let source: ModelSource = "default";

	if (input.user?.model) {
		ref = input.user.model;
		source = "user";
	} else if (input.parent?.model) {
		assertAllowed(input.parent.model, allowed, input.roles);
		if (input.remainingFraction < low) {
			ref = "s1";
			source = "router";
		} else {
			ref = input.parent.model;
			source = "parent";
		}
	} else if (input.skill?.model) {
		ref = input.skill.model;
		source = "skill";
	}

	const parsed = parseModelRef(ref, input.roles);
	const roleEffort = parsed.role ? input.roles[parsed.role].effort : undefined;

	let effort: Effort = "off";
	let effortSource: ModelSource = "default";
	if (input.user?.effort) {
		effort = input.user.effort;
		effortSource = "user";
	} else if (source === "router") {
		effort = roleEffort ?? "off";
		effortSource = "router";
	} else if (input.parent?.effort) {
		effort = input.parent.effort;
		effortSource = "parent";
	} else if (input.skill?.effort) {
		effort = input.skill.effort;
		effortSource = "skill";
	} else if (roleEffort) {
		effort = roleEffort;
	}

	return { provider: parsed.provider, id: parsed.id, role: parsed.role, effort, source, effortSource };
}
