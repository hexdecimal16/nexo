import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CliIO, runCli } from "../src/main.ts";
import { nexoVersion } from "../src/version.ts";

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

const expected = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

describe("nexo --version", () => {
	it.each(["--version", "-v"])("%s prints the package version and exits 0", async (flag) => {
		const t = io();
		const code = await runCli([flag], t);
		expect(code).toBe(0);
		expect(t.out()).toBe(`${expected}\n`);
		expect(t.err()).toBe("");
	});

	it("nexoVersion reads a semver from the repo package.json", () => {
		expect(nexoVersion()).toMatch(/^\d+\.\d+\.\d+/);
	});
});
