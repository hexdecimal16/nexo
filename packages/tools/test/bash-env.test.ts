import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bashEnv, createBuiltinTools, FileLeases } from "../src/index.ts";

const saved: Record<string, string | undefined> = {};
function setEnv(name: string, value: string): void {
	if (!(name in saved)) saved[name] = process.env[name];
	process.env[name] = value;
}
afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
		delete saved[name];
	}
});

describe("bashEnv", () => {
	it("removes variables whose names look like secrets", () => {
		const out = bashEnv({
			OPENAI_API_KEY: "a",
			ANTHROPIC_API_KEY: "a",
			GITHUB_TOKEN: "a",
			DB_PASSWORD: "a",
			AWS_SECRET_ACCESS_KEY: "a",
			AWS_ACCESS_KEY_ID: "a",
			SSH_AUTH_SOCK: "/tmp/agent",
			my_api_key: "a",
			NPM_TOKEN: "a",
			PRIVATE_KEY: "a",
		});
		expect(out).toEqual({});
	});

	it("keeps ordinary variables, including names that only contain a secret word", () => {
		const source = { PATH: "/usr/bin", HOME: "/home/u", LANG: "C", MONKEY: "1", TOKENIZER_MODE: "fast", KEYBOARD_LAYOUT: "us", PASSENGER: "x" };
		expect(bashEnv(source)).toEqual(source);
	});

	it("skips undefined values and does not change its input", () => {
		const source: NodeJS.ProcessEnv = { A: "1", B: undefined, SECRET: "s" };
		const out = bashEnv(source);
		expect(out).toEqual({ A: "1" });
		expect(source.SECRET).toBe("s");
	});
});

describe("bash tool environment", () => {
	it("does not pass secret variables to commands but keeps PATH", async () => {
		setEnv("NEXO_TEST_API_KEY", "s3cret-value");
		setEnv("NEXO_TEST_PLAIN", "visible");
		const ws = mkdtempSync(join(tmpdir(), "nexo-bash-env-"));
		const tool = createBuiltinTools({ workspaceRoot: ws, holder: "r", leases: new FileLeases(), bashTimeoutMs: 5000 }).find((t) => t.name === "bash");
		if (!tool) throw new Error("no bash tool");
		const result = await tool.execute("1", { command: 'echo "key=[$NEXO_TEST_API_KEY] plain=[$NEXO_TEST_PLAIN]"; command -v ls' });
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("key=[] plain=[visible]");
		expect(text).not.toContain("s3cret-value");
		expect(text).toContain("ls");
	});

	it("describes the filtered environment to the model", () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-bash-desc-"));
		const tool = createBuiltinTools({ workspaceRoot: ws, holder: "r", leases: new FileLeases(), bashTimeoutMs: 5000 }).find((t) => t.name === "bash");
		expect(tool?.description).toContain("environment is filtered");
		expect(tool?.description).toContain("timeoutMs");
	});
});
