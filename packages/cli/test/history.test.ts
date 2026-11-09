import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendPromptHistory, resolveNexoPaths } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { type CliIO, runCli } from "../src/main.ts";

function io(): CliIO & { out: () => string; err: () => string } {
	let out = "";
	let err = "";
	return {
		stdout: { write: (s: string) => ((out += s), true) },
		stderr: { write: (s: string) => ((err += s), true) },
		out: () => out,
		err: () => err,
	};
}

const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("nexo history", () => {
	it("lists this project's prompts oldest first, and every project's with --all", async () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-cli-hist-"));
		roots.push(root);
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		const env = { NEXO_HOME: home };
		const file = resolveNexoPaths(env).promptHistory;
		const at = "2026-11-10T00:00:00.000Z";
		const redact = createRedactor();
		appendPromptHistory(file, { text: "first", cwd: root, sessionId: "S1", at }, redact);
		appendPromptHistory(file, { text: "elsewhere", cwd: "/somewhere/else", sessionId: "S2", at }, redact);
		appendPromptHistory(file, { text: "second", cwd: root, sessionId: "S1", at }, redact);

		const here = io();
		expect(await runCli(["history"], here, { env, cwd: root })).toBe(0);
		expect(here.out().split("\n").filter(Boolean).map((l) => l.split(/\s{2}/).pop())).toEqual(["first", "second"]);

		const all = io();
		expect(await runCli(["history", "--all", "--limit", "2"], all, { env, cwd: root })).toBe(0);
		expect(all.out()).toContain("elsewhere");
		expect(all.out()).toContain("second");
		expect(all.out()).not.toContain("first");

		const bad = io();
		expect(await runCli(["history", "--limit", "0"], bad, { env, cwd: root })).not.toBe(0);
	});

	it("says so when there is no history", async () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-cli-hist-"));
		roots.push(root);
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		const t = io();
		expect(await runCli(["history"], t, { env: { NEXO_HOME: home }, cwd: root })).toBe(0);
		expect(t.out()).toContain("No prompt history");
	});
});
