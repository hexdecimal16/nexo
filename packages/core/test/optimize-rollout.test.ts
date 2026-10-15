import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type FauxResponseFactory, fauxToolCall, getSystemMessageText, type TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { loadSkills } from "@nexo/skills";
import {
	type ArtifactRow,
	ensureManualArtifact,
	getActiveArtifact,
	getRun,
	getSpent,
	insertCandidateArtifact,
	listLearnJobs,
	queryRuns,
	readRunJson,
} from "@nexo/store";
import { createEngine, createEngineEnv, DEFAULT_SYSTEM_PROMPT, executeRun, loadJudgeRubric, RunBudget } from "../src/index.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";
import { optimEnv, route } from "./optimize-helpers.ts";
import { JUDGE, JUDGE_MODELS, verdict } from "./scoring-helpers.ts";

const SKILL_HEAD = "---\nname: ci-fix\ndescription: Fix CI\n---\n";
const SKILL = `${SKILL_HEAD}Run the linter.\n`;

/** Each call answers with the next reply; every request's system prompt and first user text are kept. */
function record(env: TestEnv, replies: (string | ReturnType<typeof fauxAssistantMessage>)[]): { systems: string[]; users: string[] } {
	const seen = { systems: [] as string[], users: [] as string[] };
	let n = 0;
	const factory: FauxResponseFactory = async (context: TranscriptContext) => {
		seen.systems.push(context.messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n"));
		const msg = context.messages.find((m) => m.role === "user");
		seen.users.push(typeof msg?.content === "string" ? msg.content : (msg?.content ?? []).map((b) => ("text" in b ? b.text : "")).join(""));
		const reply = replies[n++];
		if (reply === undefined) throw new Error(`script exhausted at ${n}`);
		return typeof reply === "string" ? fauxAssistantMessage(reply) : reply;
	};
	env.faux.setResponses(Array.from({ length: 30 }, () => factory));
	return seen;
}

function activate(env: TestEnv, artifact: ArtifactRow): void {
	env.deps.db.prepare("UPDATE artifacts SET status = 'retired' WHERE kind = ? AND name = ? AND status = 'active'").run(artifact.kind, artifact.name);
	env.deps.db.prepare("UPDATE artifacts SET status = 'active' WHERE id = ?").run(artifact.id);
}

describe("promoted versions in normal runs", () => {
	it("uses a promoted skill body for --skill and load_skill until SKILL.md is edited", async () => {
		const env = makeEnv({ skills: { "ci-fix": SKILL } });
		const seen = record(env, ["first", "second", fauxAssistantMessage([fauxToolCall("load_skill", { name: "ci-fix" })]), "loaded", "third"]);
		await createEngine(env.deps).run({ instruction: "Fix CI", skill: "ci-fix" });
		const manual = getActiveArtifact(env.deps.db, "skill", "ci-fix") as ArtifactRow;
		expect(manual.origin).toBe("manual");
		activate(env, insertCandidateArtifact(env.deps.db, "skill", "ci-fix", `${SKILL_HEAD}Run the linter, then the unit tests.\n`, manual.id, new Date().toISOString()));
		const promoted = await createEngine(env.deps).run({ instruction: "Fix CI again", skill: "ci-fix" });
		expect(seen.systems[1]).toContain("Run the linter, then the unit tests.");
		expect(readFileSync(join(promoted.runDir as string, "artifacts", "skills", "ci-fix", "SKILL.md"), "utf8")).toContain("then the unit tests");
		const loaded = await createEngine(env.deps).run({ instruction: "Use the CI skill" });
		expect(loaded.messages.some((m) => m.role === "toolResult" && JSON.stringify(m.content).includes("then the unit tests"))).toBe(true);
		expect(getActiveArtifact(env.deps.db, "skill", "ci-fix")?.origin).toBe("gepa");
		writeFileSync(join(env.home, "skills", "ci-fix", "SKILL.md"), `${SKILL_HEAD}Run the linter and fix every warning.\n`);
		env.deps.skills = loadSkills(env.deps.config.skills.dirs);
		await createEngine(env.deps).run({ instruction: "Fix CI after the edit", skill: "ci-fix" });
		expect(seen.systems[4]).toContain("fix every warning");
		expect(getActiveArtifact(env.deps.db, "skill", "ci-fix")).toMatchObject({ origin: "manual", content: `${SKILL_HEAD}Run the linter and fix every warning.\n` });
	});

	it("uses a promoted system prompt while the built-in prompt is unchanged", async () => {
		const env = makeEnv();
		const seen = record(env, ["a", "b"]);
		await createEngine(env.deps).run({ instruction: "One" });
		const manual = getActiveArtifact(env.deps.db, "system_prompt", "default") as ArtifactRow;
		expect(manual.content).toBe(DEFAULT_SYSTEM_PROMPT);
		activate(env, insertCandidateArtifact(env.deps.db, "system_prompt", "default", "You are nexo. Work in {{workspace}} and be terse.", manual.id, new Date().toISOString()));
		const result = await createEngine(env.deps).run({ instruction: "Two" });
		expect(seen.systems[1]).toMatch(/^You are nexo\. Work in .+ and be terse\./);
		expect(readFileSync(join(result.runDir as string, "artifacts", "system_prompt.md"), "utf8")).toBe("You are nexo. Work in {{workspace}} and be terse.");
	});
	it("keeps a promoted file: rubric while the file is unchanged", () => {
		const env = makeEnv();
		const file = join(env.home, "rubric.md");
		writeFileSync(file, "Grade strictly.");
		const config = { ...env.deps.config, scoring: { ...env.deps.config.scoring, rubric: `file:${file}` } };
		const nowIso = new Date().toISOString();
		const manual = loadJudgeRubric(env.deps.db, config, nowIso, env.deps.redact).artifact;
		activate(env, insertCandidateArtifact(env.deps.db, "judge_rubric", "default", "Grade strictly; a skipped test fails.", manual.id, nowIso));
		expect(loadJudgeRubric(env.deps.db, config, nowIso, env.deps.redact).rubric).toBe("Grade strictly; a skipped test fails.");
		writeFileSync(file, "Grade leniently.");
		expect(loadJudgeRubric(env.deps.db, config, nowIso, env.deps.redact)).toMatchObject({ rubric: "Grade leniently.", artifact: { origin: "manual" } });
	});
});

describe("rollouts", () => {
	it("runs a candidate in isolation: own directory, optim ledger, reference for the judge, no learn job, active version untouched", async () => {
		const env = makeEnv({ skills: { "ci-fix": SKILL }, config: { ...JUDGE, learning: { enabled: true } }, extraModels: JUDGE_MODELS });
		const seen = record(env, ["Linted and tested.", verdict(0.9)]);
		const nowIso = new Date().toISOString();
		const engineEnv = createEngineEnv(env.deps);
		const base = ensureManualArtifact(env.deps.db, "skill", "ci-fix", SKILL, nowIso);
		const candidate = insertCandidateArtifact(env.deps.db, "skill", "ci-fix", `${SKILL_HEAD}Lint, then test.\n`, base.id, nowIso);
		const runsRoot = join(env.home, "optim", "01OPTIM", "rollouts");
		const result = await executeRun(engineEnv, {
			request: { instruction: "Fix CI", skill: "ci-fix" },
			budget: new RunBudget(0.5),
			rollout: { optimRunId: "01OPTIM", runsRoot, candidate, reference: "Reference answer: lint and test" },
		});
		expect(result.status).toBe("succeeded");
		expect(result.runDir?.startsWith(runsRoot)).toBe(true);
		expect(result.scores?.[0]).toMatchObject({ scorerType: "llm_judge", value: 0.9 });
		const run = getRun(env.deps.db, result.trajectoryId as string);
		expect(run?.optimRunId).toBe("01OPTIM");
		expect(readRunJson(result.runDir as string).optimRunId).toBe("01OPTIM");
		expect(getSpent(env.deps.db, "optim:01OPTIM")).toBeCloseTo(result.costUsd);
		expect(seen.systems[0]).toContain("Lint, then test.");
		expect(seen.users[1]).toContain("Reference answer: lint and test");
		expect(listLearnJobs(env.deps.db, {})).toEqual([]);
		expect(queryRuns(env.deps.db).runs.some((r) => r.id === result.trajectoryId)).toBe(false);
		expect(getActiveArtifact(env.deps.db, "skill", "ci-fix")?.id).toBe(base.id);
		expect(readFileSync(join(result.runDir as string, "artifacts", "skills", "ci-fix", "SKILL.md"), "utf8")).toContain("Lint, then test.");
		const members = JSON.parse(String(env.deps.db.prepare("SELECT members_json FROM artifact_sets WHERE id = ?").get(run?.artifactSetId as string)?.members_json));
		expect(members).toContainEqual({ kind: "skill", name: "ci-fix", artifactId: candidate.id, version: candidate.version });
	});

	it("runs no end-of-run escalation for a rollout, while a normal run with the same setup escalates", async () => {
		const setup = () => {
			const env = optimEnv();
			const calls = route(env, { agent: () => "meh", judge: () => verdict(0.3, "the reference also runs the tests"), reflect: () => "rescued" });
			return { env, calls };
		};
		const rolled = setup();
		const nowIso = new Date().toISOString();
		const base = ensureManualArtifact(rolled.env.deps.db, "skill", "ci-fix", SKILL, nowIso);
		const result = await executeRun(createEngineEnv(rolled.env.deps), {
			request: { instruction: "Fix CI", skill: "ci-fix" },
			budget: new RunBudget(0.5),
			rollout: { optimRunId: "01OPTIM", runsRoot: join(rolled.env.home, "optim", "01OPTIM", "rollouts"), candidate: base, reference: "Reference answer: lint and test" },
		});
		expect(result).toMatchObject({ status: "succeeded", output: "meh", escalations: 0 });
		expect(rolled.calls.reflect).toHaveLength(0);
		expect(rolled.calls.judge).toHaveLength(1);

		const normal = setup();
		const escalated = await createEngine(normal.env.deps).run({ instruction: "Fix CI", skill: "ci-fix" });
		expect(escalated).toMatchObject({ output: "rescued", escalations: 1 });
		expect(normal.calls.reflect).toHaveLength(1);
	});

	it("confines a rollout's writes to its own workspace and refuses ask tools without prompting", async () => {
		const env = makeEnv({ config: { tools: { nonInteractiveAsk: "deny" } } });
		let prompted = false;
		env.deps.prompter = { interactive: false, approve: async () => ((prompted = true), "once") };
		const engineEnv = createEngineEnv(env.deps);
		record(env, [
			fauxAssistantMessage([
				fauxToolCall("write", { path: "../../escape.txt", content: "x" }),
				fauxToolCall("write", { path: join(env.home, "absolute.txt"), content: "x" }),
				fauxToolCall("bash", { command: "echo hi > /tmp/nexo-rollout-escape" }),
				fauxToolCall("write", { path: "ok.txt", content: "inside" }),
			]),
			"Done.",
		]);
		const nowIso = new Date().toISOString();
		const base = ensureManualArtifact(env.deps.db, "system_prompt", "default", DEFAULT_SYSTEM_PROMPT, nowIso);
		const runsRoot = join(env.home, "optim", "01OPTIM2", "rollouts");
		const result = await executeRun(engineEnv, {
			request: { instruction: "Write files", workspace: env.home },
			budget: new RunBudget(0.5),
			rollout: { optimRunId: "01OPTIM2", runsRoot, candidate: insertCandidateArtifact(env.deps.db, "system_prompt", "default", "Be careful in {{workspace}}.", base.id, nowIso) },
		});
		const dir = result.runDir as string;
		expect(dir.startsWith(runsRoot)).toBe(true);
		expect(readRunJson(dir).workspace).toBe(join(dir, "workspace"));
		expect(readFileSync(join(dir, "workspace", "ok.txt"), "utf8")).toBe("inside");
		expect(existsSync(join(runsRoot, "escape.txt"))).toBe(false);
		expect(existsSync(join(env.home, "escape.txt"))).toBe(false);
		expect(existsSync(join(env.home, "absolute.txt"))).toBe(false);
		expect(existsSync("/tmp/nexo-rollout-escape")).toBe(false);
		const results = result.messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify(m.content));
		expect(results.filter((t) => t.includes("TOOL_DENIED"))).toHaveLength(3);
		expect(prompted).toBe(false);
	});
	it("runs a rollout's subagents on the candidate and charges them to the optimization", async () => {
		const env = makeEnv({ skills: { "ci-fix": SKILL } });
		const seen = record(env, [
			fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ id: "a", instruction: "child task", skill: "ci-fix" }] })]),
			"child done",
			"parent done",
		]);
		const nowIso = new Date().toISOString();
		const base = ensureManualArtifact(env.deps.db, "skill", "ci-fix", SKILL, nowIso);
		const candidate = insertCandidateArtifact(env.deps.db, "skill", "ci-fix", `${SKILL_HEAD}Candidate body only.\n`, base.id, nowIso);
		const result = await executeRun(createEngineEnv(env.deps), {
			request: { instruction: "Delegate" },
			budget: new RunBudget(0.5),
			rollout: { optimRunId: "01OPTIM3", runsRoot: join(env.home, "optim", "01OPTIM3", "rollouts"), candidate },
		});
		expect(result.status).toBe("succeeded");
		expect(seen.systems[1]).toContain("Candidate body only.");
		expect(seen.systems[1]).not.toContain("Run the linter.");
		const rows = env.deps.db.prepare("SELECT id, optim_run_id FROM runs WHERE root_run_id = ?").all(result.trajectoryId as string);
		expect(rows.length).toBe(2);
		expect(rows.every((r) => r.optim_run_id === "01OPTIM3")).toBe(true);
		expect(getSpent(env.deps.db, "optim:01OPTIM3")).toBeCloseTo(getSpent(env.deps.db, `run:${result.trajectoryId}`));
	});
});
