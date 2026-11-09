import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRedactor } from "@nexo/telemetry";
import { appendPromptHistory, resolveNexoPaths } from "@nexo/store";
import { afterEach, describe, expect, it } from "vitest";
import { createNexo } from "../src/index.ts";

const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Nexo.promptHistory", () => {
	it("returns this project's prompts oldest first, or every project's with all", async () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-sdk-hist-"));
		roots.push(root);
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "config.json"), JSON.stringify({ models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "fast" } } }));
		const models = createModels();
		models.setProvider(fauxProvider({ models: [{ id: "fast" }] }).provider);
		const file = resolveNexoPaths({ NEXO_HOME: home }).promptHistory;
		const at = "2026-11-10T00:00:00.000Z";
		const redact = createRedactor();
		appendPromptHistory(file, { text: "one", cwd: root, sessionId: "S1", at }, redact);
		appendPromptHistory(file, { text: "elsewhere", cwd: "/somewhere/else", sessionId: "S2", at }, redact);
		appendPromptHistory(file, { text: "two", cwd: root, sessionId: "S1", at }, redact);
		const nexo = createNexo({ home, cwd: root, env: { PATH: process.env.PATH }, models });
		try {
			expect(nexo.promptHistory().map((e) => e.text)).toEqual(["one", "two"]);
			expect(nexo.promptHistory({ all: true }).map((e) => e.text)).toEqual(["one", "elsewhere", "two"]);
			expect(nexo.promptHistory({ limit: 1 }).map((e) => e.text)).toEqual(["two"]);
		} finally {
			await nexo.close();
		}
	});
});
