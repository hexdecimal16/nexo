import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTER_POLICY } from "@nexo/router";
import { DEFAULT_JUDGE_RUBRIC } from "@nexo/scorers";
import { getActiveArtifact, openDb, resolveNexoPaths } from "@nexo/store";
import { createRedactor, NexoError } from "@nexo/telemetry";
import { judgeFamilyWarnings, judgeKey, loadConfig, loadJudgeRubric, loadRouterPolicy, type NexoConfig } from "../src/index.ts";

const models = { s1: { provider: "anthropic", id: "claude-haiku-5-5" }, s2: { provider: "openai", id: "gpt-x" } };
const redact = createRedactor();

function setup(home: unknown) {
	const root = mkdtempSync(join(tmpdir(), "nexo-scfg-"));
	const paths = resolveNexoPaths({ NEXO_HOME: join(root, "home") });
	const cwd = join(root, "proj");
	mkdirSync(paths.home, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(paths.config, JSON.stringify(home));
	return { paths, cwd, root };
}

function configError(fn: () => unknown): NexoError {
	try {
		fn();
	} catch (error) {
		if (error instanceof NexoError && error.code === "CONFIG_INVALID") return error;
		throw error;
	}
	throw new Error("expected CONFIG_INVALID");
}

describe("scoring config", () => {
	it("defaults to judge-only scoring with the artifact policy and rubric", () => {
		const { paths, cwd } = setup({ models });
		const { config } = loadConfig({ paths, cwd });
		expect(config.scoring).toEqual({ enabled: true, scorers: [], rubric: "artifact:judge_rubric", passThreshold: 0.6, commandTimeoutMs: 120_000, subagents: false, scorersOrigin: "user" });
		expect(config.router.policy).toBe("artifact:router_policy");
		expect(judgeKey(config)).toBeNull();
	});

	it("makes file: sources absolute against the working directory", () => {
		const { paths, cwd } = setup({ models, router: { policy: "file:./policy.json" }, scoring: { rubric: "file:rubric.md" } });
		const { config } = loadConfig({ paths, cwd });
		expect(config.router.policy).toBe(`file:${join(cwd, "policy.json")}`);
		expect(config.scoring.rubric).toBe(`file:${join(cwd, "rubric.md")}`);
	});

	it("rejects bad scorer specs, sources and thresholds with CONFIG_INVALID", () => {
		const bad = (scoring: unknown, router?: unknown) => {
			const { paths, cwd } = setup({ models, scoring, ...(router ? { router } : {}) });
			return configError(() => loadConfig({ paths, cwd })).message;
		};
		expect(bad({ scorers: [{ kind: "shell", command: "x" }] })).toContain("/scoring/scorers/0");
		expect(bad({ scorers: [{ kind: "regex", pattern: "(" }] })).toContain("/0/pattern does not compile");
		expect(bad({ scorers: [{ kind: "contains", text: "a" }, { kind: "contains", text: "b" }] })).toContain('repeats the scorer name "contains"');
		expect(bad({ passThreshold: 1.5 })).toContain("/scoring/passThreshold");
		expect(bad({ rubric: "judge.md" })).toContain("/scoring/rubric");
		expect(bad({}, { policy: "router_policy" })).toContain("/router/policy");
		expect(bad({ scorers: [{ kind: "contains", text: "a" }, { kind: "llm_judge" }] })).toContain("/scoring/scorers/1 is an llm_judge scorer, but models.judge is not set");
	});

	it("records whether scoring.scorers came from the project config, whatever the file says", () => {
		const { paths, cwd } = setup({ models });
		mkdirSync(join(cwd, ".nexo"), { recursive: true });
		writeFileSync(join(cwd, ".nexo", "config.json"), JSON.stringify({ scoring: { scorers: [{ kind: "contains", text: "x" }], scorersOrigin: "user" } }));
		expect(loadConfig({ paths, cwd }).config.scoring.scorersOrigin).toBe("project");
		expect(loadConfig({ paths, cwd, overrides: { scoring: { scorers: [] } } }).config.scoring.scorersOrigin).toBe("user");
		const home = setup({ models, scoring: { scorers: [{ kind: "contains", text: "x" }] } });
		expect(loadConfig({ paths: home.paths, cwd: home.cwd }).config.scoring.scorersOrigin).toBe("user");
	});

	it("records project origin only when the project config itself defines scorers", () => {
		const { paths, cwd } = setup({ models, scoring: { scorers: [{ kind: "contains", text: "x" }] } });
		mkdirSync(join(cwd, ".nexo"), { recursive: true });
		writeFileSync(join(cwd, ".nexo", "config.json"), JSON.stringify({ scoring: { passThreshold: 0.7 } }));
		expect(loadConfig({ paths, cwd }).config.scoring.scorersOrigin).toBe("user");
	});

	it("keeps scorersOrigin out of the config hash", () => {
		const a = setup({ models });
		const b = setup({ models, scoring: { scorersOrigin: "project" } });
		expect(loadConfig({ paths: a.paths, cwd: a.cwd }).hash).toBe(loadConfig({ paths: b.paths, cwd: b.cwd }).hash);
	});

	describe("file: sources from the project config", () => {
		function project(scoring: unknown, router?: unknown) {
			const ctx = setup({ models });
			mkdirSync(join(ctx.cwd, ".nexo"), { recursive: true });
			writeFileSync(join(ctx.cwd, ".nexo", "config.json"), JSON.stringify({ scoring, ...(router ? { router } : {}) }));
			return ctx;
		}
		it("refuses $NEXO_HOME, ~, parent-relative, absolute-outside and symlinked-out paths", () => {
			const ctx = project({ rubric: "file:$NEXO_HOME/credentials.json" });
			writeFileSync(join(ctx.paths.home, "credentials.json"), "{}");
			expect(configError(() => loadConfig(ctx)).message).toContain("/scoring/rubric");
			for (const rubric of ["file:~/.ssh/id_ed25519", "file:../outside.md", "file:/etc/passwd"]) {
				const c = project({ rubric });
				writeFileSync(join(c.root, "outside.md"), "secret");
				expect(configError(() => loadConfig(c)).message).toContain("/scoring/rubric");
			}
			const link = project({ rubric: "file:link.md" });
			writeFileSync(join(link.root, "target.md"), "secret");
			symlinkSync(join(link.root, "target.md"), join(link.cwd, "link.md"));
			expect(configError(() => loadConfig(link)).message).toContain("points outside");
			const pol = project({}, { policy: "file:../p.json" });
			expect(configError(() => loadConfig(pol)).message).toContain("/router/policy");
		});
		it("accepts a file inside the project, and a user-level file elsewhere", () => {
			const ctx = project({ rubric: "file:rubric.md" });
			writeFileSync(join(ctx.cwd, "rubric.md"), "grade");
			expect(loadConfig(ctx).config.scoring.rubric).toMatch(/^file:.*rubric\.md$/);
			const user = setup({ models, scoring: { rubric: "file:$NEXO_HOME/r.md" } });
			expect(loadConfig({ paths: user.paths, cwd: user.cwd }).config.scoring.rubric).toBe(`file:${join(user.paths.home, "r.md")}`);
		});
	});

	it("names the judge key and warns about a judge from the s1 or s2 family", () => {
		const config = { models: { ...models, judge: [{ provider: "openrouter", id: "openai/gpt-y" }, { provider: "google", id: "gemini-x" }] } } as unknown as NexoConfig;
		expect(judgeKey(config)).toBe("openrouter/openai/gpt-y+google/gemini-x");
		expect(judgeFamilyWarnings(config)).toEqual([expect.stringContaining("Judge openrouter/openai/gpt-y is from the same model family (openai) as openai/gpt-x")]);
	});

	it("groups one judge matching both s1 and s2 into one warning", () => {
		const config = { models: { s1: { provider: "openai", id: "gpt-a" }, s2: { provider: "openai", id: "gpt-b" }, judge: [{ provider: "openai", id: "gpt-j" }] } } as unknown as NexoConfig;
		const warnings = judgeFamilyWarnings(config);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("openai/gpt-a and openai/gpt-b");
	});
});

describe("router policy and judge rubric artifacts", () => {
	function base(overrides: Partial<NexoConfig> = {}): NexoConfig {
		const { paths, cwd } = setup({ models });
		return { ...loadConfig({ paths, cwd }).config, ...overrides };
	}

	it("seeds version 1 from the defaults and keeps an active version", () => {
		const db = openDb(":memory:");
		const first = loadRouterPolicy(db, base(), "2026-10-11T00:00:00.000Z", redact);
		expect(first.policy).toEqual(DEFAULT_ROUTER_POLICY);
		expect(first.artifact).toMatchObject({ kind: "router_policy", name: "default", version: 1 });
		expect(loadRouterPolicy(db, base(), "2026-10-11T00:00:01.000Z", redact).artifact.id).toBe(first.artifact.id);
		expect(loadJudgeRubric(db, base(), "2026-10-11T00:00:00.000Z", redact).rubric.trim()).toBe(DEFAULT_JUDGE_RUBRIC);
	});

	it("stores a file: policy as a new version and rejects an invalid one", () => {
		const db = openDb(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "nexo-pol-"));
		writeFileSync(join(dir, "p.json"), JSON.stringify({ triggers: { tool_failures: { consecutive: 5 } } }));
		const config = base();
		const fromFile = loadRouterPolicy(db, { ...config, router: { ...config.router, policy: `file:${join(dir, "p.json")}` } }, "2026-10-11T00:00:00.000Z", redact);
		expect(fromFile.policy.triggers.tool_failures.consecutive).toBe(5);
		expect(getActiveArtifact(db, "router_policy", "default")?.id).toBe(fromFile.artifact.id);
		writeFileSync(join(dir, "bad.json"), JSON.stringify({ triggers: { judge_low: { threshold: 3 } } }));
		expect(configError(() => loadRouterPolicy(db, { ...config, router: { ...config.router, policy: `file:${join(dir, "bad.json")}` } }, "2026-10-11T00:00:00.000Z", redact)).message).toContain(
			"/triggers/judge_low/threshold",
		);
		expect(configError(() => loadJudgeRubric(db, { ...config, scoring: { ...config.scoring, rubric: `file:${join(dir, "missing.md")}` } }, "2026-10-11T00:00:00.000Z", redact)).message).toContain("scoring.rubric");
		writeFileSync(join(dir, "empty.md"), "  \n");
		expect(configError(() => loadJudgeRubric(db, { ...config, scoring: { ...config.scoring, rubric: `file:${join(dir, "empty.md")}` } }, "2026-10-11T00:00:00.000Z", redact)).message).toContain("empty");
	});

	it("redacts a file: rubric, reuses an unchanged version and versions a changed one", () => {
		const db = openDb(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "nexo-rub-"));
		const file = join(dir, "r.md");
		const config = base();
		const cfg = { ...config, scoring: { ...config.scoring, rubric: `file:${file}` } };
		writeFileSync(file, "grade with key sk-ant-abcdefghijklmnopqrstuvwxyz");
		const v1 = loadJudgeRubric(db, cfg, "2026-10-11T00:00:00.000Z", redact);
		expect(v1.artifact.content).toContain("[REDACTED]");
		expect(v1.artifact.content).not.toContain("sk-ant-");
		expect(loadJudgeRubric(db, cfg, "2026-10-11T00:00:01.000Z", redact).artifact.id).toBe(v1.artifact.id);
		writeFileSync(file, "new criteria");
		expect(loadJudgeRubric(db, cfg, "2026-10-11T00:00:02.000Z", redact).artifact.version).toBe(2);
	});

	it("rejects an oversized or non-regular file: source without echoing content", () => {
		const db = openDb(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "nexo-big-"));
		writeFileSync(join(dir, "big.md"), "x".repeat(300 * 1024));
		writeFileSync(join(dir, "p.json"), "SECRET-TEXT not json");
		const config = base();
		const rubric = (f: string) => loadJudgeRubric(db, { ...config, scoring: { ...config.scoring, rubric: `file:${f}` } }, "2026-10-11T00:00:00.000Z", redact);
		expect(configError(() => rubric(join(dir, "big.md"))).message).toContain("larger than");
		expect(configError(() => rubric(dir)).message).toContain("not a regular file");
		const err = configError(() => loadRouterPolicy(db, { ...config, router: { ...config.router, policy: `file:${join(dir, "p.json")}` } }, "2026-10-11T00:00:00.000Z", redact));
		expect(JSON.stringify([err.message, err.hint])).not.toContain("SECRET-TEXT");
	});
});
