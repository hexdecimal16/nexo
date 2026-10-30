import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { insertRun, openDb, resolveNexoPaths } from "@nexo/store";
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

function cliHome(): { env: NodeJS.ProcessEnv; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "nexo-cli-rq-"));
	roots.push(root);
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "config.json"), JSON.stringify({ models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "slow" } }, learning: { enabled: false } }));
	return { env: { NEXO_HOME: home }, cwd: root };
}

describe("nexo review-queue", () => {
	it("says so when nothing needs review", async () => {
		const h = cliHome();
		const io = captureIo();
		expect(await runCli(["review-queue"], io, h)).toBe(0);
		expect(io.out()).toContain("No unreviewed runs");
	});

	it("prints failed runs before unscored ones and honours --limit", async () => {
		const h = cliHome();
		const db = openDb(resolveNexoPaths(h.env).db);
		const now = new Date().toISOString();
		insertRun(db, runRow({ id: "fine", status: "succeeded", startedAt: now, instruction: "Tidy notes" }));
		insertRun(db, runRow({ id: "broke", status: "failed", startedAt: now, instruction: "Deploy site" }));
		db.close();
		const io = captureIo();
		expect(await runCli(["review-queue"], io, h)).toBe(0);
		const out = io.out();
		expect(out.indexOf("broke")).toBeLessThan(out.indexOf("fine"));
		expect(out).toMatch(/broke\s+failed/);
		expect(out).toMatch(/fine\s+unscored/);
		const one = captureIo();
		expect(await runCli(["review-queue", "--limit", "1"], one, h)).toBe(0);
		expect(one.out()).toContain("broke");
		expect(one.out()).not.toContain("fine");
	});

	it("rejects bad flags with exit 2", async () => {
		const h = cliHome();
		for (const args of [["--limit", "0"], ["--days", "x"], ["--limit", "1.5"]]) {
			const io = captureIo();
			expect(await runCli(["review-queue", ...args], io, h), args.join(" ")).toBe(2);
			expect(io.err()).toContain("must be a positive integer");
		}
	});

	it("is listed in the usage text with the new settings keys", async () => {
		const io = captureIo();
		await runCli(["help"], io, cliHome());
		const text = io.out() + io.err();
		expect(text).toContain("nexo review-queue");
		expect(text).toContain("loop.maxToolCalls|repeatLimit");
		expect(text).toContain("reflectionTier|maxCaseDrop");
	});
});
