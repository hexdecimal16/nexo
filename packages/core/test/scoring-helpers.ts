import { type AssistantMessage, fauxAssistantMessage, type FauxModelDefinition, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import type { DeepPartial, NexoConfig } from "../src/index.ts";
import { firstUserText, makeEnv, type TestEnv } from "./helpers.ts";

export const ROLES = { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } };

/** Config with the faux roles and these judge model ids (makeEnv replaces `models` as a whole). */
export function judges(...ids: string[]): DeepPartial<NexoConfig> {
	return { models: { ...ROLES, judge: ids.map((id) => ({ provider: "faux", id })) } };
}

export const JUDGE = judges("gemini-judge");

/** Judge models from other families than the faux generators (family is derived from the id). */
export const JUDGE_MODELS: FauxModelDefinition[] = [
	{ id: "gemini-judge", cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 } },
	{ id: "gpt-judge", cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 } },
];

/** makeEnv with the judge models registered. */
export function judgeEnv(options: Parameters<typeof makeEnv>[0] = {}): TestEnv {
	return makeEnv({ ...options, extraModels: JUDGE_MODELS });
}

export function verdict(score: number, rationale = "Looks complete."): string {
	return JSON.stringify({ score, criteria: [{ name: "completes_instruction", passed: score >= 0.6, note: "checked" }], rationale });
}

/** One scripted reply per call: judge calls (models *-judge) take from `judge`, everything else from `agent`. */
export function route(env: TestEnv, agent: (AssistantMessage | FauxResponseFactory)[], judge: string[] = []): { agentCalls: () => number; judgeCalls: () => number; prompts: string[] } {
	let a = 0;
	let j = 0;
	const prompts: string[] = [];
	const factory: FauxResponseFactory = async (context: TranscriptContext, opts, state, model) => {
		if (model.id.endsWith("-judge")) {
			prompts.push(firstUserText(context));
			const reply = judge[j++];
			if (reply === undefined) throw new Error(`judge script exhausted at ${j}`);
			return fauxAssistantMessage(reply);
		}
		const step = agent[a++];
		if (step === undefined) throw new Error(`agent script exhausted at ${a}`);
		return typeof step === "function" ? step(context, opts, state, model) : step;
	};
	env.faux.setResponses(Array.from({ length: 40 }, () => factory));
	return { agentCalls: () => a, judgeCalls: () => j, prompts };
}

/** A SKILL.md with these metadata strings. */
export function skillMd(name: string, meta: Record<string, string>): string {
	const lines = Object.entries(meta).map(([k, v]) => `  ${k}: "${v}"`);
	return `---\nname: ${name}\ndescription: test skill\n${lines.length ? `metadata:\n${lines.join("\n")}\n` : ""}---\nDo the task.\n`;
}
