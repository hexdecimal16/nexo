import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { addSpend, dayScope, getRun, getSpent, insertRun, listSpans, readRunJson, readTrajectory } from "@nexo/store";
import { REDACTED } from "@nexo/telemetry";
import { runRow } from "../../store/test/fixtures.ts";
import { createEngine, registerExtraTools } from "../src/index.ts";
import { lastToolResultText, makeEnv } from "./helpers.ts";

const SKILL = "---\nname: summarize\ndescription: Summarize text\nmetadata:\n  nexo-model: faux/slow\n---\nSummarize briefly.\n";

describe("engine run", () => {
	it("completes a simple run and records run.json, spans, cost and artifacts", async () => {
		const env = makeEnv();
		env.faux.setResponses([fauxAssistantMessage("All done.")]);
		const result = await createEngine(env.deps).run({ instruction: "Say done" });

		expect(result).toMatchObject({ status: "succeeded", output: "All done.", costUnknown: false });
		expect(result.costUsd).toBeGreaterThan(0);
		const dir = result.runDir as string;
		const runJson = readRunJson(dir);
		expect(runJson).toMatchObject({ status: "succeeded", model: { provider: "faux", id: "fast", source: "default", role: "s1" } });
		expect(existsSync(join(dir, "artifacts", "system_prompt.md"))).toBe(true);
		expect(existsSync(join(dir, "artifacts", "config.json"))).toBe(true);
		const spans = listSpans(env.deps.db, result.trajectoryId as string);
		expect(spans.map((s) => s.kind)).toEqual(expect.arrayContaining(["run", "turn", "llm_call"]));
		const llm = spans.find((s) => s.kind === "llm_call");
		expect(llm).toMatchObject({ model: "fast", tier: "s1", modelSource: "default", status: "ok" });
		expect(llm?.costUsd).toBeCloseTo(result.costUsd);
		expect(getRun(env.deps.db, result.trajectoryId as string)?.status).toBe("succeeded");
		expect(getSpent(env.deps.db, `run:${result.trajectoryId}`)).toBeCloseTo(result.costUsd);
		expect(readTrajectory(dir).length).toBe(spans.length);
	});

	it("executes tools inside the isolated run workspace", async () => {
		const env = makeEnv();
		env.faux.setResponses([
			fauxAssistantMessage([fauxText("Writing."), fauxToolCall("write", { path: "out/a.txt", content: "hi" })]),
			fauxAssistantMessage("Wrote it."),
		]);
		const result = await createEngine(env.deps).run({ instruction: "Write a file" });
		expect(result.status).toBe("succeeded");
		expect(readFileSync(join(result.runDir as string, "workspace", "out", "a.txt"), "utf8")).toBe("hi");
		const tool = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "tool_call");
		expect(tool).toMatchObject({ name: "write", status: "ok" });
	});

	it("blocks denied tools without failing the run", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "deny" } } } });
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })]), fauxAssistantMessage("Could not run it.")]);
		const result = await createEngine(env.deps).run({ instruction: "Run echo" });
		expect(result.status).toBe("succeeded");
		const tool = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.name === "bash");
		expect(tool?.status).toBe("error");
		expect(JSON.stringify(tool?.attrs)).toContain("TOOL_DENIED");
	});

	it("shows the model a tool error's code and hint", async () => {
		const env = makeEnv();
		let toolResult = "";
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "../../outside.txt" })]),
			async (ctx) => {
				toolResult = lastToolResultText(ctx);
				return fauxAssistantMessage("ok");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "Read outside" });
		expect(result.status).toBe("succeeded");
		expect(toolResult).toMatch(/^TOOL_DENIED: Path "..\/..\/outside.txt" is outside the workspace/);
		expect(toolResult).toContain("hint: Use a path inside the workspace");
	});

	it("ends with budget_exceeded once the first call overspends, keeping the partial trajectory", async () => {
		const env = makeEnv({ config: { budgets: { perRunUsd: 0.5, estimateOutputTokens: 1 } } });
		env.faux.setResponses([
			fauxAssistantMessage([fauxText("x".repeat(4000)), fauxToolCall("read", { path: "missing.txt" })]),
			fauxAssistantMessage("never reached"),
		]);
		const result = await createEngine(env.deps).run({ instruction: "Expensive", model: "faux/pricey" });
		expect(result.status).toBe("budget_exceeded");
		expect(result.error?.code).toBe("BUDGET_EXCEEDED");
		expect(result.costUsd).toBeGreaterThan(0.5);
		const llmCalls = listSpans(env.deps.db, result.trajectoryId as string).filter((s) => s.kind === "llm_call" && s.costUsd > 0);
		expect(llmCalls).toHaveLength(1);
	});

	it("refuses admission when the daily ledger is exhausted", async () => {
		const env = makeEnv();
		addSpend(env.deps.db, [dayScope(new Date())], 100, new Date().toISOString());
		const result = await createEngine(env.deps).run({ instruction: "anything" });
		expect(result).toMatchObject({ status: "budget_exceeded", trajectoryId: null, error: { code: "BUDGET_EXCEEDED" } });
	});

	it("retries retryable provider errors and succeeds", async () => {
		const env = makeEnv();
		env.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" }),
			fauxAssistantMessage("Recovered."),
		]);
		const result = await createEngine(env.deps).run({ instruction: "retry me" });
		expect(result).toMatchObject({ status: "succeeded", output: "Recovered." });
		const llm = listSpans(env.deps.db, result.trajectoryId as string).filter((s) => s.kind === "llm_call");
		expect(llm.map((s) => s.status)).toEqual(["error", "ok"]);
		const spanTotal = llm.reduce((sum, s) => sum + s.costUsd, 0);
		expect(spanTotal).toBeCloseTo(result.costUsd, 10);
		expect(getSpent(env.deps.db, `run:${result.trajectoryId}`)).toBeCloseTo(result.costUsd, 10);
		expect(getRun(env.deps.db, result.trajectoryId as string)?.costUsd).toBeCloseTo(result.costUsd, 10);
	});

	it("fails with PROVIDER_AUTH on non-retryable auth errors", async () => {
		const env = makeEnv();
		env.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized: invalid x-api-key" })]);
		const result = await createEngine(env.deps).run({ instruction: "auth" });
		expect(result.status).toBe("failed");
		expect(result.error).toMatchObject({ code: "PROVIDER_AUTH" });
		expect(result.error?.hint).toContain("API key");
	});

	it("returns SKILL_NOT_FOUND without creating a run directory", async () => {
		const env = makeEnv();
		const result = await createEngine(env.deps).run({ instruction: "x", skill: "missing" });
		expect(result).toMatchObject({ status: "failed", trajectoryId: null, error: { code: "SKILL_NOT_FOUND" } });
	});

	it("returns CONFIG_INVALID for an invalid budget without creating a run directory", async () => {
		const env = makeEnv();
		const result = await createEngine(env.deps).run({ instruction: "x", budgetUsd: -1 });
		expect(result).toMatchObject({ status: "failed", trajectoryId: null, error: { code: "CONFIG_INVALID" } });
	});

	it("runs a skill with its default model and records the source", async () => {
		const env = makeEnv({ skills: { summarize: SKILL } });
		env.faux.setResponses([fauxAssistantMessage("Summary.")]);
		const result = await createEngine(env.deps).run({ instruction: "Summarize this", skill: "summarize" });
		expect(result.status).toBe("succeeded");
		const llm = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "llm_call");
		expect(llm).toMatchObject({ model: "slow", modelSource: "skill", tier: "s2" });
		expect(existsSync(join(result.runDir as string, "artifacts", "skills", "summarize", "SKILL.md"))).toBe(true);
	});

	it("records changes made in a --workspace directory", async () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-real-ws-"));
		writeFileSync(join(ws, "a.txt"), "old\n");
		const env = makeEnv();
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("edit", { path: "a.txt", oldText: "old", newText: "new" })]), fauxAssistantMessage("Edited.")]);
		const result = await createEngine(env.deps).run({ instruction: "Edit", workspace: ws });
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("new\n");
		const diff = readFileSync(join(result.runDir as string, "changes", "changes.diff"), "utf8");
		expect(diff).toContain("-old");
		expect(diff).toContain("+new");
	});

	it("marks runs of dead processes as aborted when the engine starts", () => {
		const env = makeEnv();
		insertRun(env.deps.db, runRow({ id: "crashed", dirPath: "/x", pid: 2147483646 }));
		createEngine(env.deps);
		expect(getRun(env.deps.db, "crashed")?.status).toBe("aborted");
	});

	it("ends as aborted when the caller aborts", async () => {
		const env = makeEnv();
		const ac = new AbortController();
		env.faux.setResponses([
			async () => {
				ac.abort();
				await new Promise((r) => setTimeout(r, 50));
				return fauxAssistantMessage("late");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "slow" }, ac.signal);
		expect(result.status).toBe("aborted");
		expect(readRunJson(result.runDir as string).status).toBe("aborted");
	});

	it("makes no LLM call when the signal is already aborted", async () => {
		const env = makeEnv();
		let calls = 0;
		env.faux.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("should not run");
			},
		]);
		const ac = new AbortController();
		ac.abort();
		const result = await createEngine(env.deps).run({ instruction: "never" }, ac.signal);
		expect(calls).toBe(0);
		expect(result.status).toBe("aborted");
		expect(readRunJson(result.runDir as string).status).toBe("aborted");
		expect(getRun(env.deps.db, result.trajectoryId as string)?.status).toBe("aborted");
	});

	it("rejects a missing workspace without creating a run directory or row", async () => {
		const env = makeEnv();
		const result = await createEngine(env.deps).run({ instruction: "x", workspace: join(tmpdir(), "nexo-no-such-dir-xyz") });
		expect(result).toMatchObject({ status: "failed", trajectoryId: null, runDir: null, error: { code: "CONFIG_INVALID" } });
		expect(readdirSync(env.deps.paths.runs)).toEqual([]);
		expect(env.deps.db.prepare("SELECT COUNT(*) AS n FROM runs").get()?.n).toBe(0);
	});

	it("records a failed terminal status when setup throws after the run row exists", async () => {
		const env = makeEnv();
		const unregister = registerExtraTools(() => {
			throw new Error("factory exploded");
		});
		try {
			const result = await createEngine(env.deps).run({ instruction: "boom" });
			expect(result).toMatchObject({ status: "failed", error: { code: "INTERNAL", message: "factory exploded" } });
			expect(getRun(env.deps.db, result.trajectoryId as string)?.status).toBe("failed");
			expect(readRunJson(result.runDir as string).status).toBe("failed");
			const runSpan = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "run");
			expect(runSpan?.status).toBe("error");
			expect(runSpan?.endedAt).not.toBeNull();
		} finally {
			unregister();
		}
	});

	it("stops before an LLM call the budget cannot afford", async () => {
		const env = makeEnv({ config: { budgets: { perRunUsd: 0.5 } } });
		let calls = 0;
		env.faux.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("plain answer");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "too pricey", model: "faux/pricey" });
		expect(calls).toBe(0);
		expect(result.status).toBe("budget_exceeded");
		expect(result.error?.code).toBe("BUDGET_EXCEEDED");
		expect(result.costUsd).toBe(0);
	});

	it("redacts secrets in the error result and run_start event", async () => {
		const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
		const env = makeEnv();
		const events: unknown[] = [];
		env.deps.onEvent = (e) => events.push(e);
		env.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: `401 Unauthorized: bad key ${secret}` })]);
		const result = await createEngine(env.deps).run({ instruction: `use ${secret}` });
		expect(result.status).toBe("failed");
		expect(JSON.stringify(result.error)).not.toContain(secret);
		expect(JSON.stringify(events)).not.toContain(secret);
	});

	it("flags unpriced models as cost unknown", async () => {
		const env = makeEnv();
		env.faux.setResponses([fauxAssistantMessage("ok")]);
		const result = await createEngine(env.deps).run({ instruction: "free", model: "faux/free" });
		expect(result.costUnknown).toBe(true);
	});

	it("redacts secrets in the instruction and tool output everywhere", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } } } });
		const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `echo ${secret}` })]), fauxAssistantMessage("done")]);
		const result = await createEngine(env.deps).run({ instruction: `use ${secret}` });
		const dir = result.runDir as string;
		for (const file of ["run.json", "trajectory.jsonl", "artifacts/config.json"]) {
			const text = readFileSync(join(dir, file), "utf8");
			expect(text).not.toContain(secret);
		}
		expect(readFileSync(join(dir, "run.json"), "utf8")).toContain(REDACTED);
		const rows = env.deps.db.prepare("SELECT attrs_json FROM spans").all().map((r) => String(r.attrs_json)).join("\n");
		expect(rows).not.toContain(secret);
		expect(getRun(env.deps.db, result.trajectoryId as string)?.instruction).not.toContain(secret);
	});

	it("offloads tool results over 32 KB to tool_outputs", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } } } });
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "head -c 40000 /dev/zero | tr '\\0' 'b'" })]), fauxAssistantMessage("ok")]);
		const result = await createEngine(env.deps).run({ instruction: "big output" });
		const tool = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.name === "bash");
		expect(tool?.payloadRef).toMatch(/^tool_outputs\/.+\.txt$/);
		expect(readFileSync(join(result.runDir as string, tool?.payloadRef as string), "utf8").length).toBeGreaterThan(40000);
	});

	it("sends the model a head and tail excerpt of a large tool result with a pointer it can read", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } } } });
		let excerpt = "";
		let readBack = "";
		const pointer = () => /@tool_outputs\/[A-Z0-9]+\.txt/.exec(excerpt)?.[0] ?? "missing";
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "seq 1 100000" })]),
			async (ctx) => {
				excerpt = lastToolResultText(ctx);
				return fauxAssistantMessage([fauxToolCall("read", { path: pointer(), offset: 50001, limit: 2 })]);
			},
			async (ctx) => {
				readBack = lastToolResultText(ctx);
				return fauxAssistantMessage("ok");
			},
		]);
		const result = await createEngine(env.deps).run({ instruction: "huge output" });
		expect(result.status).toBe("succeeded");
		expect(excerpt.length).toBeLessThan(20_000);
		expect(excerpt.startsWith("exit code: 0\n1\n2\n3\n")).toBe(true);
		expect(excerpt.endsWith("99999\n100000\n")).toBe(true);
		expect(excerpt).toMatch(/\[\d+ characters omitted\. The full output is saved; read it with read\(\{ path: "@tool_outputs\/[A-Z0-9]+\.txt"/);
		const tool = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.name === "bash");
		expect(pointer()).toBe(`@${tool?.payloadRef}`);
		expect(readBack).toBe("50000\n50001");
	});

	it("fails a context-window overflow without retrying it", async () => {
		const env = makeEnv();
		let calls = 0;
		env.faux.setResponses(
			Array.from({ length: 4 }, () => () => {
				calls++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 prompt is too long: 250000 tokens > 200000 maximum" });
			}),
		);
		const result = await createEngine(env.deps).run({ instruction: "overflow" });
		expect(calls).toBe(1);
		expect(result.status).toBe("failed");
		expect(result.error).toMatchObject({ code: "PROVIDER_CONTEXT_OVERFLOW", retryable: false });
	});

	it("records what the model said, with tool calls and redacted arguments, on the llm_call span", async () => {
		const env = makeEnv();
		const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
		env.faux.setResponses([
			fauxAssistantMessage([fauxText("Writing."), fauxToolCall("write", { path: "a.txt", content: `key=${secret}` })]),
			fauxAssistantMessage("Wrote it."),
		]);
		const result = await createEngine(env.deps).run({ instruction: "Write a file" });
		const llm = listSpans(env.deps.db, result.trajectoryId as string).filter((s) => s.kind === "llm_call");
		expect(llm[0]?.attrs.content).toEqual([
			{ type: "text", text: "Writing." },
			{ type: "toolCall", id: expect.any(String), name: "write", arguments: { path: "a.txt", content: `key=${REDACTED}` } },
		]);
		expect(llm[1]?.attrs.content).toEqual([{ type: "text", text: "Wrote it." }]);
		expect(readFileSync(join(result.runDir as string, "trajectory.jsonl"), "utf8")).not.toContain(secret);
	});

	it("offloads assistant content over 32 KB from the llm_call span to tool_outputs", async () => {
		const env = makeEnv({ config: { budgets: { perRunUsd: 5 } } });
		env.faux.setResponses([fauxAssistantMessage("z".repeat(40_000))]);
		const result = await createEngine(env.deps).run({ instruction: "long answer" });
		const llm = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.kind === "llm_call");
		expect(llm?.attrs.content).toBeUndefined();
		expect(llm?.payloadRef).toBe(`tool_outputs/${llm?.id}.txt`);
		const saved = JSON.parse(readFileSync(join(result.runDir as string, llm?.payloadRef as string), "utf8"));
		expect(saved).toEqual([{ type: "text", text: "z".repeat(40_000) }]);
	});

	it("redacts secrets in snapshotted and loaded skill artifacts stored in SQLite", async () => {
		const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
		const skill = (name: string) => `---\nname: ${name}\ndescription: Uses a key\n---\nCall the API with ${secret}.\n`;
		const env = makeEnv({ skills: { active: skill("active"), extra: skill("extra") } });
		env.faux.setResponses([fauxAssistantMessage([fauxToolCall("load_skill", { name: "extra" })]), fauxAssistantMessage("done")]);
		const result = await createEngine(env.deps).run({ instruction: "use skills", skill: "active" });
		expect(result.status).toBe("succeeded");
		const rows = env.deps.db.prepare("SELECT name, content FROM artifacts WHERE kind = 'skill'").all();
		expect(rows.map((r) => r.name).sort()).toEqual(["active", "extra"]);
		for (const row of rows) {
			expect(String(row.content)).not.toContain(secret);
			expect(String(row.content)).toContain(REDACTED);
		}
	});

	it("redacts secrets in offloaded tool_outputs files", async () => {
		const env = makeEnv({ config: { tools: { policy: { bash: "allow" } } } });
		const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: `head -c 40000 /dev/zero | tr '\\0' 'b'; echo; echo ${secret}` })]),
			fauxAssistantMessage("ok"),
		]);
		const result = await createEngine(env.deps).run({ instruction: "big secret output" });
		const tool = listSpans(env.deps.db, result.trajectoryId as string).find((s) => s.name === "bash");
		const saved = readFileSync(join(result.runDir as string, tool?.payloadRef as string), "utf8");
		expect(saved.length).toBeGreaterThan(40000);
		expect(saved).not.toContain(secret);
		expect(saved).toContain(REDACTED);
	});

	it("ends as aborted without an INTERNAL error when aborted during retry backoff", async () => {
		const env = makeEnv();
		const ac = new AbortController();
		env.deps.sleep = (_ms, signal) => {
			ac.abort();
			return Promise.reject(signal?.reason ?? new Error("aborted"));
		};
		env.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" }), fauxAssistantMessage("never")]);
		const result = await createEngine(env.deps).run({ instruction: "backoff" }, ac.signal);
		expect(result.status).toBe("aborted");
		expect(result.error).toBeUndefined();
		expect(readRunJson(result.runDir as string)).toMatchObject({ status: "aborted", error: null });
		expect(getRun(env.deps.db, result.trajectoryId as string)?.error).toBeNull();
	});
});
