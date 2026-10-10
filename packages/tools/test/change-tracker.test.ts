import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { createRedactor } from "@nexo/telemetry";
import type { NexoError } from "@nexo/telemetry";
import { createChangeTracker } from "../src/index.ts";

const redact = createRedactor();

describe("createChangeTracker", () => {
	it("records before/after copies and a unified diff for modified and created files", () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-ws-"));
		const changes = mkdtempSync(join(tmpdir(), "nexo-changes-"));
		writeFileSync(join(ws, "a.txt"), "old\n");
		writeFileSync(join(ws, "same.txt"), "same\n");
		const tracker = createChangeTracker(ws, changes, redact);

		tracker.beforeWrite(join(ws, "a.txt"));
		writeFileSync(join(ws, "a.txt"), "new\n");
		tracker.beforeWrite(join(ws, "b.txt"));
		writeFileSync(join(ws, "b.txt"), "created\n");
		tracker.beforeWrite(join(ws, "same.txt"));

		expect(tracker.finalize()).toEqual([
			{ path: "a.txt", kind: "modified" },
			{ path: "b.txt", kind: "created" },
			{ path: "same.txt", kind: "unchanged" },
		]);
		expect(readFileSync(join(changes, "before", "a.txt"), "utf8")).toBe("old\n");
		expect(readFileSync(join(changes, "after", "b.txt"), "utf8")).toBe("created\n");
		const diff = readFileSync(join(changes, "changes.diff"), "utf8");
		expect(diff).toContain("-old");
		expect(diff).toContain("+new");
		expect(diff).toContain("+created");
		expect(diff).not.toContain("same");
		expect(existsSync(join(changes, "before", "b.txt"))).toBe(false);
	});

	it("redacts secrets in copies and the diff", () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-ws-"));
		const changes = mkdtempSync(join(tmpdir(), "nexo-changes-"));
		const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";
		writeFileSync(join(ws, "k.txt"), `key=${secret}\n`);
		const tracker = createChangeTracker(ws, changes, redact);
		tracker.beforeWrite(join(ws, "k.txt"));
		writeFileSync(join(ws, "k.txt"), `key=${secret}2\n`);
		tracker.finalize();
		for (const file of [join("before", "k.txt"), join("after", "k.txt"), "changes.diff"]) {
			expect(readFileSync(join(changes, file), "utf8")).not.toContain("sk-ant-api03");
		}
	});

	it("rejects directories with TOOL_DENIED", () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-ws-"));
		mkdirSync(join(ws, "d"));
		const tracker = createChangeTracker(ws, mkdtempSync(join(tmpdir(), "nexo-changes-")), redact);
		try {
			tracker.beforeWrite(join(ws, "d"));
			expect.unreachable();
		} catch (err) {
			expect((err as NexoError).code).toBe("TOOL_DENIED");
		}
	});
});
