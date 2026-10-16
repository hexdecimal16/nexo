import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getEvalCase, insertRun, openDb, resolveNexoPaths } from "@nexo/store";
import { runRow } from "../../store/test/fixtures.ts";
import { type CliIO, runCli } from "../src/main.ts";

function captureIo(): CliIO & { out: () => string; err: () => string } {
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

/** A temporary NEXO_HOME whose config has no embedding model, so mining groups runs by word overlap. */
function cliHome(): { env: NodeJS.ProcessEnv; home: string } {
	const root = mkdtempSync(join(tmpdir(), "nexo-cli-eval-cases-"));
	roots.push(root);
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "config.json"), JSON.stringify({ models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } }, learning: { enabled: false } }));
	return { env: { NEXO_HOME: home }, home: root };
}

describe("nexo eval mine / accept / dismiss / golden revert", () => {
	it("mines a cluster, accepts one case with a golden, dismisses another, and refuses repeat decisions", async () => {
		const { env, home } = cliHome();
		const db = openDb(resolveNexoPaths(env).db);
		for (let i = 0; i < 3; i++) insertRun(db, runRow({ status: "succeeded", instruction: "Write the weekly status update", startedAt: new Date(Date.now() - i * 60_000).toISOString(), endedAt: new Date().toISOString() }));
		for (let i = 0; i < 3; i++) insertRun(db, runRow({ status: "succeeded", instruction: "Summarize open pull requests", startedAt: new Date(Date.now() - (10 + i) * 60_000).toISOString(), endedAt: new Date().toISOString() }));
		db.close();
		const io = captureIo();
		expect(await runCli(["eval", "mine", "--target", "system_prompt"], io, { env, cwd: home })).toBe(0);
		const ids = [...io.out().matchAll(/proposed (\S+)/g)].map((m) => m[1] as string);
		expect(ids).toHaveLength(2);
		expect(await runCli(["eval", "accept", ids[0] as string, "--expected", "The update."], io, { env, cwd: home })).toBe(0);
		expect(await runCli(["eval", "dismiss", ids[1] as string], io, { env, cwd: home })).toBe(0);
		const check = openDb(resolveNexoPaths(env).db);
		expect(getEvalCase(check, ids[0] as string)).toMatchObject({ status: "active", expected: "The update.", goldenSource: "manual" });
		expect(getEvalCase(check, ids[1] as string)?.status).toBe("dismissed");
		check.close();
		expect(await runCli(["eval", "dismiss", ids[0] as string], io, { env, cwd: home })).not.toBe(0);
		expect(io.err()).toMatch(/is active, not proposed/);
		expect(await runCli(["eval", "golden", "revert", ids[0] as string], io, { env, cwd: home })).not.toBe(0);
		expect(io.err()).toMatch(/not from climb/);
	});

	it("rejects bad usage", async () => {
		const { env, home } = cliHome();
		const io = captureIo();
		expect(await runCli(["eval", "mine"], io, { env, cwd: home })).not.toBe(0);
		expect(await runCli(["eval", "mine", "--target", "judge_rubric"], io, { env, cwd: home })).not.toBe(0);
		expect(await runCli(["eval", "accept"], io, { env, cwd: home })).not.toBe(0);
		expect(await runCli(["eval", "golden", "bogus", "X"], io, { env, cwd: home })).not.toBe(0);
	});
});
