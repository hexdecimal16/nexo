import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NexoError } from "@nexo/telemetry";
import { runBash, trackedBashGroups } from "../../tools/src/builtin.ts";
import {
	type CommandRunner,
	commandScorer,
	containsScorer,
	extractJson,
	humanScorer,
	jsonSchemaScorer,
	loadScorerFile,
	MAX_MATCHED_OUTPUT_CHARS,
	parseScorerSpecs,
	regexScorer,
	type ScoreInput,
} from "../src/index.ts";

function input(finalOutput: string, workspace = tmpdir()): ScoreInput {
	return { runId: "r1", instruction: "do it", finalOutput, runDir: workspace, workspace, trajectory: [] };
}

const signal = new AbortController().signal;

/** The runner core injects: the bash tool's `runBash`, which kills the whole process group on timeout, abort and exit. */
const run: CommandRunner = (r) => runBash(r);

async function failure(promise: Promise<unknown>): Promise<NexoError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof NexoError) return error;
		throw error;
	}
	throw new Error("expected a NexoError");
}

describe("command scorer", () => {
	it("passes on exit code 0 in the workspace and keeps the output as a log file", async () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-cmd-"));
		writeFileSync(join(ws, "a.txt"), "hello");
		const r = await commandScorer({ name: "check", command: "cat a.txt", timeoutMs: 5000, run }).score(input("", ws), signal);
		expect(r).toMatchObject({ value: 1, passed: true, costUsd: 0, details: { exitCode: 0 } });
		expect(r.rationale).toBe("exit code 0\nhello");
		expect(r.files).toEqual({ "check.log": "$ cat a.txt\nhello" });
	});

	it("fails on a non-zero exit code with the output tail as rationale", async () => {
		const r = await commandScorer({ name: "check", command: "echo broken >&2; exit 3", timeoutMs: 5000, run }).score(input(""), signal);
		expect(r).toMatchObject({ value: 0, passed: false, details: { exitCode: 3 } });
		expect(r.rationale).toBe("exit code 3\nbroken");
	});

	it("throws SCORER_FAILED on timeout and kills child processes", async () => {
		const started = Date.now();
		const error = await failure(commandScorer({ name: "slow", command: "sleep 20 & sleep 20; wait", timeoutMs: 150, run }).score(input(""), signal));
		expect(error).toMatchObject({ code: "SCORER_FAILED", message: "Command scorer slow timed out after 150ms" });
		expect(error.hint).toContain("timeoutMs");
		expect(Date.now() - started).toBeLessThan(5000);
		expect(trackedBashGroups()).toEqual([]);
	});

	it("kills backgrounded children when the command times out", async () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-kill-"));
		const command = "sleep 30 & echo $! > child.pid; sleep 30; wait";
		await failure(commandScorer({ name: "slow", command, timeoutMs: 400, run }).score(input("", ws), signal));
		const pid = Number(readFileSync(join(ws, "child.pid"), "utf8").trim());
		expect(pid).toBeGreaterThan(0);
		await new Promise((r) => setTimeout(r, 100));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("marks truncated output", async () => {
		const truncating: CommandRunner = async () => ({ output: "partial", exitCode: 0, ended: "exited", truncated: true });
		const r = await commandScorer({ name: "t", command: "x", timeoutMs: 1000, run: truncating }).score(input(""), signal);
		expect(r.rationale).toContain("[output truncated]");
		expect(r.files?.["t.log"]).toContain("[output truncated]");
	});

	it("throws SCORER_FAILED when aborted", async () => {
		const controller = new AbortController();
		const pending = commandScorer({ name: "slow", command: "sleep 20", timeoutMs: 10_000, run }).score(input(""), controller.signal);
		setTimeout(() => controller.abort(), 50);
		expect((await failure(pending)).message).toContain("was aborted");
	});

	it("throws SCORER_FAILED when bash cannot start, and gives the runner the workspace and timeout", async () => {
		const seen: unknown[] = [];
		const broken: CommandRunner = async (r) => {
			seen.push({ cwd: r.cwd, timeoutMs: r.timeoutMs, command: r.command });
			return { output: "spawn bash ENOENT", exitCode: null, ended: "failed" };
		};
		const error = await failure(commandScorer({ name: "check", command: "true", timeoutMs: 700, run: broken }).score(input("", "/ws"), signal));
		expect(error).toMatchObject({ code: "SCORER_FAILED", message: "Command scorer check could not start bash: spawn bash ENOENT" });
		expect(seen).toEqual([{ cwd: "/ws", timeoutMs: 700, command: "true" }]);
	});
});

describe("output scorers", () => {
	it("json_schema validates the output, or the body of a json fence", async () => {
		const scorer = jsonSchemaScorer({ name: "shape", schema: { type: "object", required: ["n"], properties: { n: { type: "number" } } } });
		expect((await scorer.score(input('{"n": 1}'), signal)).passed).toBe(true);
		expect((await scorer.score(input('Here:\n```json\n{"n": 2}\n```'), signal)).passed).toBe(true);
		const bad = await scorer.score(input('{"n": "x"}'), signal);
		expect(bad).toMatchObject({ passed: false, value: 0 });
		expect(bad.rationale).toContain("/n must be number");
		expect((await scorer.score(input("no json here"), signal)).rationale).toContain("Not valid JSON");
		expect(() => extractJson("plain")).toThrow("no ```json block");
	});

	it("regex and contains match the output, with negate and ignoreCase", async () => {
		expect((await regexScorer({ name: "r", pattern: "^done", flags: "i" }).score(input("Done."), signal)).passed).toBe(true);
		expect((await regexScorer({ name: "r", pattern: "error", negate: true }).score(input("an error"), signal)).passed).toBe(false);
		expect((await containsScorer({ name: "c", text: "PASS", ignoreCase: true }).score(input("tests pass"), signal)).passed).toBe(true);
		expect((await containsScorer({ name: "c", text: "TODO", negate: true }).score(input("all done"), signal)).passed).toBe(true);
	});

	it("regex and contains look at the first MAX_MATCHED_OUTPUT_CHARS of the output only", async () => {
		const long = `${"a".repeat(MAX_MATCHED_OUTPUT_CHARS)}NEEDLE`;
		expect((await containsScorer({ name: "c", text: "NEEDLE" }).score(input(long), signal)).passed).toBe(false);
		expect((await regexScorer({ name: "r", pattern: "NEEDLE" }).score(input(long), signal)).passed).toBe(false);
		expect((await containsScorer({ name: "c", text: "NEEDLE" }).score(input("aNEEDLE"), signal)).passed).toBe(true);
	});

	it("json_schema finds an unclosed fence in linear time", async () => {
		const scorer = jsonSchemaScorer({ name: "shape", schema: { type: "object" } });
		const started = Date.now();
		const r = await scorer.score(input(`\`\`\`${"\n".repeat(100_000)}`), signal);
		expect(r.passed).toBe(false);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it("json_schema ignores output past MAX_MATCHED_OUTPUT_CHARS", async () => {
		const scorer = jsonSchemaScorer({ name: "shape", schema: { type: "object" } });
		expect((await scorer.score(input(`{}${" ".repeat(MAX_MATCHED_OUTPUT_CHARS)}x`), signal)).passed).toBe(true);
	});

	it("json_schema fails with SCORER_FAILED when the schema cannot be applied", async () => {
		const scorer = jsonSchemaScorer({ name: "shape", schema: { type: "string", pattern: "(" } });
		expect((await failure(scorer.score(input('"x"'), signal))).code).toBe("SCORER_FAILED");
	});

	it("regex stops a catastrophic pattern with SCORER_FAILED", async () => {
		const started = Date.now();
		const error = await failure(regexScorer({ name: "r", pattern: "^(a+)+$" }).score(input(`${"a".repeat(40)}b`), signal));
		expect(error.code).toBe("SCORER_FAILED");
		expect(error.hint).toContain("simplify");
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("regex factory rejects an invalid pattern with CONFIG_INVALID", () => {
		expect(() => regexScorer({ name: "r", pattern: "(" })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
	});

	it("contains ignoreCase handles non-ASCII text", async () => {
		expect((await containsScorer({ name: "c", text: "ÉCOLE", ignoreCase: true }).score(input("la école"), signal)).passed).toBe(true);
	});

	it("human reads the latest verdict and fails without one", async () => {
		const scorer = humanScorer({ name: "human", readVerdict: (id) => (id === "r1" ? { verdict: "not_done", comment: "missed a file" } : undefined) });
		expect(await scorer.score(input(""), signal)).toMatchObject({ value: 0, passed: false, rationale: "missed a file" });
		const approving = humanScorer({ name: "human", readVerdict: () => ({ verdict: "done", comment: "" }) });
		expect(await approving.score(input(""), signal)).toMatchObject({ value: 1, passed: true, rationale: "Reviewed as done" });
		expect((await failure(scorer.score({ ...input(""), runId: "r2" }, signal))).code).toBe("SCORER_FAILED");
	});
});

describe("scorer specs", () => {
	it("accepts every kind and rejects bad entries with CONFIG_INVALID naming the index", () => {
		const specs = parseScorerSpecs(
			[
				{ kind: "command", command: "npm test", timeoutMs: 60000 },
				{ kind: "json_schema", schema: { type: "object" } },
				{ kind: "regex", name: "starts", pattern: "^ok" },
				{ kind: "contains", text: "done" },
				{ kind: "llm_judge", rubric: "Must cite sources." },
				{ kind: "human" },
			],
			"t",
		);
		expect(specs.map((s) => s.kind)).toEqual(["command", "json_schema", "regex", "contains", "llm_judge", "human"]);
		const bad = (raw: unknown) => {
			try {
				parseScorerSpecs(raw, "spec.json");
			} catch (error) {
				return (error as NexoError).code === "CONFIG_INVALID" ? (error as NexoError).message : "wrong code";
			}
			return "accepted";
		};
		expect(bad({})).toContain("expected an array");
		expect(bad([{ kind: "shell", command: "x" }])).toContain("/0/kind must be one of");
		expect(bad([{ kind: "command" }])).toContain("/0");
		expect(bad([{ kind: "regex", pattern: "(" }])).toContain("/0/pattern does not compile");
		expect(bad([{ kind: "regex", pattern: "a".repeat(1001) }])).toContain("/0/pattern");
		expect(parseScorerSpecs([{ kind: "regex", pattern: "a".repeat(1000) }], "t")).toHaveLength(1);
		expect(bad([{ kind: "contains", text: "a" }, { kind: "contains", text: "b" }])).toContain('repeats the scorer name "contains"');
		expect(bad([{ kind: "command", command: "x", extra: 1 }])).toContain("spec.json");
		expect(bad([{ kind: "json_schema", schema: { type: "string", pattern: "(" } }])).toContain("/0/schema");
		expect(bad([{ kind: "json_schema", schema: { properties: { n: { type: "bogus" } } } }])).toContain("/0/schema");
		expect(bad([{ kind: "json_schema", schema: { $ref: "#/missing" } }])).toContain("/0/schema");
		expect(parseScorerSpecs([{ kind: "json_schema", schema: { $defs: { a: { type: "string" } }, $ref: "#/$defs/a" } }], "t")).toHaveLength(1);
	});

	it("loads a skill's scorer file as an array or as { scorers }", () => {
		const dir = mkdtempSync(join(tmpdir(), "nexo-spec-"));
		writeFileSync(join(dir, "a.json"), JSON.stringify([{ kind: "contains", text: "x" }]));
		writeFileSync(join(dir, "b.json"), JSON.stringify({ scorers: [{ kind: "human" }] }));
		writeFileSync(join(dir, "c.json"), "{");
		expect(loadScorerFile(join(dir, "a.json"))).toEqual([{ kind: "contains", text: "x" }]);
		expect(loadScorerFile(join(dir, "b.json"))).toEqual([{ kind: "human" }]);
		expect(() => loadScorerFile(join(dir, "c.json"))).toThrow("Cannot read scorer spec");
		expect(() => loadScorerFile(join(dir, "missing.json"))).toThrow("Cannot read scorer spec");
	});
});
