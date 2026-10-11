import { appendFileSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRedactor, NexoError, REDACTED } from "@nexo/telemetry";
import { getRun, listChildRuns, listSpans, openDb, readRunJson, readTrajectory, reindex, RunDir, type RunJson } from "../src/index.ts";
import { spanRow } from "./fixtures.ts";

const redact = createRedactor();

function runJson(id: string, overrides: Partial<RunJson> = {}): RunJson {
	return {
		id,
		parentRunId: null,
		rootRunId: id,
		instruction: "task",
		skill: null,
		status: "succeeded",
		model: { provider: "faux", id: "fast", effort: "off", source: "default", role: "s1" },
		startedAt: "2026-10-10T00:00:00.000Z",
		endedAt: "2026-10-10T00:00:05.000Z",
		costUsd: 0.01,
		costUnknown: false,
		tokensIn: 10,
		tokensOut: 5,
		output: "done",
		error: null,
		artifactSetId: null,
		configSnapshotHash: "h",
		workspace: "/w",
		taskGraphs: [],
		...overrides,
	};
}

describe("RunDir", () => {
	it("creates the spec layout", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-runs-"));
		const dir = RunDir.create(root, "r1", redact);
		for (const sub of ["artifacts", "context", "workspace", "tool_outputs", "scores", "subagents"]) {
			expect(existsSync(join(dir.root, sub))).toBe(true);
		}
		const child = dir.child("c1");
		expect(child.root).toBe(join(root, "r1", "subagents", "c1"));
		expect(existsSync(child.workspaceDir)).toBe(true);
	});

	it("writes run.json and trajectory with redaction; last trajectory record per span wins", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-runs-"));
		const dir = RunDir.create(root, "r1", redact);
		dir.writeRunJson(runJson("r1", { instruction: "use key sk-ant-abcdefghijklmnopqrstu" }));
		expect(readRunJson(dir.root).instruction).toBe(`use key ${REDACTED}`);
		const s = spanRow("r1", { status: "running" });
		dir.appendTrajectory(s);
		dir.appendTrajectory({ ...s, status: "ok" });
		expect(readTrajectory(dir.root)).toEqual([{ ...s, status: "ok" }]);
	});

	it("confines artifact paths and offloads tool output", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-runs-"));
		const dir = RunDir.create(root, "r1", redact);
		dir.writeArtifact("skills/a/SKILL.md", "body");
		expect(readFileSync(join(dir.artifactsDir, "skills/a/SKILL.md"), "utf8")).toBe("body");
		expect(() => dir.writeArtifact("../escape.txt", "x")).toThrow(NexoError);
		const rel = dir.writeToolOutput("span1", "big output");
		expect(rel).toBe("tool_outputs/span1.txt");
		expect(readFileSync(join(dir.root, rel), "utf8")).toBe("big output");
	});
});

describe("reindex", () => {
	it("rebuilds runs and spans from nested run directories and skips broken ones", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-runs-"));
		const parent = RunDir.create(root, "p1", redact);
		parent.writeRunJson(runJson("p1"));
		parent.appendTrajectory(spanRow("p1"));
		const child = parent.child("c1");
		child.writeRunJson(runJson("c1", { parentRunId: "p1", rootRunId: "p1" }));
		child.appendTrajectory(spanRow("c1"));
		child.appendTrajectory(spanRow("c1", { kind: "tool_call", name: "read" }));
		const broken = RunDir.create(root, "bad", redact);
		writeFileSync(join(broken.root, "run.json"), "{not json");

		const db = openDb(":memory:");
		const result = reindex(db, root);
		expect(result).toEqual({ runs: 2, spans: 3, sessions: 0, skipped: [broken.root] });
		expect(getRun(db, "p1")?.dirPath).toBe(parent.root);
		expect(listChildRuns(db, "p1").map((r) => r.id)).toEqual(["c1"]);
		expect(listSpans(db, "c1")).toHaveLength(2);
		expect(reindex(db, root).runs).toBe(2);
	});

	it("indexes a run.json still marked running as aborted without rewriting run.json", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-runs-"));
		const dir = RunDir.create(root, "r1", redact);
		dir.writeRunJson(runJson("r1", { status: "running", endedAt: null }));
		const db = openDb(":memory:");
		reindex(db, root);
		const row = getRun(db, "r1");
		expect(row?.status).toBe("aborted");
		expect(row?.endedAt).toBeNull();
		expect(row?.error).toEqual({
			code: "INTERNAL",
			message: "The run was still marked running when the index was rebuilt",
			retryable: false,
		});
		expect(readRunJson(dir.root).status).toBe("running");
	});

	it("indexes a run whose trajectory has a truncated last line", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-runs-"));
		const dir = RunDir.create(root, "r1", redact);
		dir.writeRunJson(runJson("r1"));
		dir.appendTrajectory(spanRow("r1"));
		appendFileSync(join(dir.root, "trajectory.jsonl"), '{"id":"cut","runI');
		const db = openDb(":memory:");
		expect(reindex(db, root)).toEqual({ runs: 1, spans: 1, sessions: 0, skipped: [] });
		expect(listSpans(db, "r1")).toHaveLength(1);
	});

	it("isolates corrupt directories so good runs are still indexed", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-runs-"));
		RunDir.create(root, "a-null", redact);
		writeFileSync(join(root, "a-null", "run.json"), "null");
		const dup = RunDir.create(root, "z-dup", redact);
		dup.writeRunJson(runJson("good"));
		const good = RunDir.create(root, "good", redact);
		good.writeRunJson(runJson("good"));
		good.appendTrajectory(spanRow("good"));
		const orphan = RunDir.create(root, "c-orphan", redact);
		orphan.writeRunJson(runJson("c-orphan"));
		orphan.appendTrajectory(spanRow("nonexistent-run"));
		symlinkSync(join(root, "missing-target"), join(root, "d-broken-link"));
		const db = openDb(":memory:");
		const result = reindex(db, root);
		expect(result.skipped.sort()).toEqual([join(root, "a-null"), join(root, "c-orphan"), join(root, "z-dup")]);
		expect(getRun(db, "good")?.dirPath).toBe(good.root);
		expect(listSpans(db, "good")).toHaveLength(1);
		expect(result.runs).toBe(1);
		expect(result.spans).toBe(1);
	});
});
