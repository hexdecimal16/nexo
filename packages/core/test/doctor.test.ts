import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNexoPaths } from "@nexo/store";
import { createSettings, runDoctor } from "../src/index.ts";

const models = { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } };

function setup(config?: unknown) {
	const root = mkdtempSync(join(tmpdir(), "nexo-doctor-"));
	const env = { NEXO_HOME: join(root, "home"), PATH: "" } as NodeJS.ProcessEnv;
	const paths = resolveNexoPaths(env);
	const cwd = join(root, "proj");
	mkdirSync(paths.home, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	if (config !== undefined) writeFileSync(paths.config, typeof config === "string" ? config : JSON.stringify(config));
	const settings = createSettings({ paths, cwd, env });
	return { paths, settings, env, cwd };
}

const status = (report: ReturnType<typeof runDoctor>, id: string) => report.checks.find((c) => c.id === id)?.status;

describe("runDoctor", () => {
	it("passes with warnings on a valid config", () => {
		const report = runDoctor(setup({ models }));
		expect(report.ok).toBe(true);
		expect(status(report, "config")).toBe("ok");
		expect(status(report, "models")).toBe("ok");
		expect(status(report, "judge")).toBe("warn");
	});

	it("fails on a first run without models", () => {
		const report = runDoctor(setup());
		expect(report.ok).toBe(false);
		expect(status(report, "config")).toBe("fail");
		expect(status(report, "models")).toBe("fail");
	});

	it("fails on a config that is not valid JSON and names the file", () => {
		const ctx = setup("{ not json");
		const report = runDoctor(ctx);
		expect(report.ok).toBe(false);
		expect(report.checks.find((c) => c.id === "config")?.message).toContain(ctx.paths.config);
	});

	it("fails on an old Node version", () => {
		const report = runDoctor({ ...setup({ models }), nodeVersion: "v20.1.0" });
		expect(status(report, "node")).toBe("fail");
		expect(report.ok).toBe(false);
	});

	it("warns about an MCP server whose command is missing", () => {
		const report = runDoctor(setup({ models, mcp: { servers: { demo: { command: "nexo-no-such-command" } } } }));
		expect(status(report, "mcp:demo")).toBe("warn");
		expect(report.ok).toBe(true);
	});
});
