import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Redactor } from "@nexo/telemetry";
import { appendPromptHistory, readPromptHistory, resolveNexoPaths } from "../src/index.ts";

const redact: Redactor = (v) => JSON.parse(JSON.stringify(v).replaceAll("hunter2", "[REDACTED]"));
const entry = (text: string, cwd: string) => ({ text, cwd, sessionId: "S1", at: "2026-11-10T00:00:00.000Z" });

describe("prompt history", () => {
	it("lives in the nexo home", () => {
		expect(resolveNexoPaths({ NEXO_HOME: "/tmp/nx" }).promptHistory).toBe("/tmp/nx/history.jsonl");
	});

	it("appends redacted, trimmed prompts and reads them oldest first, scoped to a project", () => {
		const file = join(mkdtempSync(join(tmpdir(), "nexo-hist-")), "history.jsonl");
		expect(readPromptHistory(file)).toEqual([]);
		appendPromptHistory(file, entry("  first  ", "/p"), redact);
		appendPromptHistory(file, entry("   ", "/p"), redact);
		appendPromptHistory(file, entry("password hunter2", "/p/sub"), redact);
		appendPromptHistory(file, entry("password hunter2", "/p/sub"), redact);
		appendPromptHistory(file, entry("elsewhere", "/other"), redact);
		appendPromptHistory(file, entry("sibling", "/p2"), redact);
		appendFileSync(file, "{not json\n");
		appendPromptHistory(file, entry("/model s2", "/p"), redact);

		const texts = (opts?: Parameters<typeof readPromptHistory>[1]) => readPromptHistory(file, opts).map((e) => e.text);
		expect(texts({ underDir: ["/p"] })).toEqual(["first", "password [REDACTED]", "/model s2"]);
		expect(texts()).toEqual(["first", "password [REDACTED]", "elsewhere", "sibling", "/model s2"]);
		expect(texts({ underDir: "/p", limit: 2 })).toEqual(["password [REDACTED]", "/model s2"]);
		expect(readPromptHistory(file, { underDir: "/p" })[0]).toEqual({ text: "first", cwd: "/p", sessionId: "S1", at: "2026-11-10T00:00:00.000Z" });
	});
});
