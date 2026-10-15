import { fauxAssistantMessage, type FauxResponseFactory, fauxToolCall, getSystemMessageText, type TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { listSpans } from "@nexo/store";
import type { ApprovalRequest, Prompter, SessionRule } from "@nexo/tools";
import { join } from "node:path";
import { ensureManualArtifact, insertCandidateArtifact } from "@nexo/store";
import { createEngine, createEngineEnv, DEFAULT_SYSTEM_PROMPT, type EngineEvent, executeRun, RunBudget } from "../src/index.ts";
import { makeEnv } from "./helpers.ts";

/** Agent replies in order; calls whose system prompt is the approver's get `approver` replies instead. */
function script(env: ReturnType<typeof makeEnv>, agent: ReturnType<typeof fauxAssistantMessage>[], approver: string[]) {
	let a = 0;
	let j = 0;
	const factory: FauxResponseFactory = async (ctx: TranscriptContext) => {
		const system = ctx.messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n");
		if (system.startsWith("You decide whether an AI agent may run one tool action")) return fauxAssistantMessage(approver[j++] ?? "{}");
		return agent[a++] ?? fauxAssistantMessage("done");
	};
	env.faux.setResponses(Array.from({ length: 30 }, () => factory));
	return { approverCalls: () => j };
}

function prompter(answer: "once" | "always" | "deny"): Prompter & { asked: ApprovalRequest[] } {
	const asked: ApprovalRequest[] = [];
	return { interactive: true, asked, approve: async (r) => (asked.push(r), answer) };
}

const bashCall = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })]);

describe("approvals in the engine", () => {
	it("auto mode allows without asking, emits an approval event and records approvedBy and the spans", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "ask" }, autoApprove: "on" } } });
		const p = prompter("deny");
		env.deps.prompter = p;
		const events: EngineEvent[] = [];
		env.deps.onEvent = (e) => events.push(e);
		const s = script(env, [bashCall("echo hi"), fauxAssistantMessage("done")], ['{"decision":"allow","reason":"prints text"}']);
		const result = await createEngine(env.deps).run({ instruction: "say hi" });
		expect(result.status).toBe("succeeded");
		expect(p.asked).toHaveLength(0);
		expect(s.approverCalls()).toBe(1);
		expect(events.find((e) => e.type === "approval")).toMatchObject({ toolName: "bash", reason: "prints text", depth: 0 });
		const spans = listSpans(env.deps.db, result.trajectoryId as string);
		const tool = spans.find((x) => x.kind === "tool_call" && x.name === "bash");
		expect(tool?.attrs).toMatchObject({ approvedBy: "auto" });
		expect(spans.find((x) => x.kind === "approval")?.parentSpanId).toBe(tool?.id);
	});

	it("auto mode ask shows the box with the reason; off never calls the approver", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "ask" }, autoApprove: "on" } } });
		const p = prompter("once");
		env.deps.prompter = p;
		script(env, [bashCall("git push"), fauxAssistantMessage("done")], ['{"decision":"ask","reason":"pushes to a remote"}']);
		await createEngine(env.deps).run({ instruction: "push" });
		expect(p.asked[0]?.note).toBe("auto: pushes to a remote");

		const off = makeEnv({ config: { tools: { policy: { bash: "ask" } } } });
		off.deps.prompter = prompter("once");
		const s = script(off, [bashCall("echo x"), fauxAssistantMessage("done")], []);
		await createEngine(off.deps).run({ instruction: "x" });
		expect(s.approverCalls()).toBe(0);
		// RunRequest.autoApprove overrides the config.
		const s2 = script(off, [bashCall("echo y"), fauxAssistantMessage("done")], ['{"decision":"allow","reason":"ok"}']);
		await createEngine(off.deps).run({ instruction: "y", autoApprove: true });
		expect(s2.approverCalls()).toBe(1);
	});

	it("session rules from the request skip the box, Always allow adds one, and subagents inherit them", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "ask" } } } });
		const rules: SessionRule[] = [];
		const p = prompter("always");
		env.deps.prompter = p;
		script(
			env,
			[
				bashCall("npm run test -- -a"),
				fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "c", instruction: "CHILD" }] })]),
				bashCall("npm run test -- -b"), // the child: covered by the rule just added
				fauxAssistantMessage("child done"),
				fauxAssistantMessage("parent done"),
			],
			[],
		);
		const result = await createEngine(env.deps).run({ instruction: "test", sessionRules: () => rules, addSessionRule: (r) => rules.push(r) });
		expect(result.status).toBe("succeeded");
		expect(p.asked).toHaveLength(1);
		expect(rules).toEqual([{ tool: "bash", kind: "prefix", value: "npm run test" }]);
	});

	it("optimization rollouts never use session rules or the approver", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "ask" }, autoApprove: "on" } } });
		const s = script(env, [bashCall("npm run test"), fauxAssistantMessage("done")], ['{"decision":"allow","reason":"x"}']);
		const nowIso = new Date().toISOString();
		const base = ensureManualArtifact(env.deps.db, "system_prompt", "default", DEFAULT_SYSTEM_PROMPT, nowIso);
		const candidate = insertCandidateArtifact(env.deps.db, "system_prompt", "default", `${DEFAULT_SYSTEM_PROMPT}\nBe brief.`, base.id, nowIso);
		const result = await executeRun(createEngineEnv(env.deps), {
			request: { instruction: "test", sessionRules: () => [{ tool: "bash", kind: "prefix", value: "npm run test" }], autoApprove: true },
			budget: new RunBudget(0.5),
			rollout: { optimRunId: "01OPTIMAPPROVE", runsRoot: join(env.home, "optim", "01OPTIMAPPROVE", "rollouts"), candidate },
		});
		expect(s.approverCalls()).toBe(0);
		const spans = listSpans(env.deps.db, result.trajectoryId as string);
		expect(spans.some((x) => x.kind === "approval")).toBe(false);
		expect(spans.find((x) => x.kind === "tool_call" && x.name === "bash")?.attrs.approvedBy).toBeUndefined();
	});
});
