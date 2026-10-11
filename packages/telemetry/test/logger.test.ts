import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger, createMutableRedactor, createRedactor, createSecretSet, NexoError, REDACTED } from "../src/index.ts";

function readLines(dir: string, day: string): Record<string, unknown>[] {
	return readFileSync(join(dir, `nexo-${day}.log`), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("createLogger", () => {
	const now = () => new Date("2026-10-10T12:00:00.000Z");

	it("writes JSON lines with ts, level, msg, component and fields, redacted", () => {
		const dir = mkdtempSync(join(tmpdir(), "nexo-log-"));
		const log = createLogger({ dir, component: "engine", redact: createRedactor(), now });
		log.info("run started", { run_id: "r1", apiKey: "secret" });
		const [line] = readLines(dir, "2026-10-10");
		expect(line).toEqual({
			ts: "2026-10-10T12:00:00.000Z",
			level: "info",
			msg: "run started",
			component: "engine",
			run_id: "r1",
			apiKey: REDACTED,
		});
	});

	it("filters below the configured level", () => {
		const dir = mkdtempSync(join(tmpdir(), "nexo-log-"));
		const log = createLogger({ dir, component: "c", redact: createRedactor(), now, level: "warn" });
		log.info("hidden");
		log.warn("shown");
		expect(readLines(dir, "2026-10-10").map((l) => l.msg)).toEqual(["shown"]);
	});

	it("child loggers merge fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "nexo-log-"));
		const log = createLogger({ dir, component: "c", redact: createRedactor(), now }).child({ correlation_id: "x" });
		log.error("failed", { span_id: "s" });
		expect(readLines(dir, "2026-10-10")[0]).toMatchObject({ correlation_id: "x", span_id: "s", level: "error" });
	});

	it("serializes Error values as error payloads", () => {
		const dir = mkdtempSync(join(tmpdir(), "nexo-log-"));
		const log = createLogger({ dir, component: "c", redact: createRedactor(), now });
		log.error("failed", { error: new NexoError({ code: "STORE_IO", message: "disk" }) });
		expect(readLines(dir, "2026-10-10")[0]?.error).toEqual({ code: "STORE_IO", message: "disk", retryable: false });
	});
});

describe("createLogger with a mutable redactor", () => {
	it("applies secrets added and redactors replaced after the logger was created", () => {
		const dir = mkdtempSync(join(tmpdir(), "nexo-log-"));
		const secrets = createSecretSet();
		const redact = createMutableRedactor(createRedactor([], { secrets }));
		const log = createLogger({ dir, component: "cli", redact, now: () => new Date("2026-10-10T12:00:00.000Z") });
		secrets.add("added-later-secret");
		log.info("first", { out: "x added-later-secret" });
		redact.replace(createRedactor(["acct-[0-9]{6}"], { secrets }));
		log.child({ c: 1 }).info("second", { out: "acct-123456 added-later-secret" });
		const lines = readLines(dir, "2026-10-10");
		expect(lines[0]?.out).toBe(`x ${REDACTED}`);
		expect(lines[1]?.out).toBe(`${REDACTED} ${REDACTED}`);
	});
});
