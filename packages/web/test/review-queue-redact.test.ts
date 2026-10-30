import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, insertRun, openDb } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { runRow } from "../../store/test/fixtures.ts";
import { startWebServer, type WebServer } from "../src/index.ts";
import { raw } from "./http.ts";

let db: Db;
let server: WebServer;

beforeAll(async () => {
	db = openDb(join(mkdtempSync(join(tmpdir(), "nexo-web-rqr-")), "nexo.db"));
	insertRun(db, runRow({ status: "failed", startedAt: new Date().toISOString(), instruction: "Use key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd to deploy <script>x</script>" }));
	server = await startWebServer({ db, redact: createRedactor(), port: 0, readOnly: { message: "config invalid", hint: null } });
});
afterAll(async () => {
	await server.close();
});

describe("GET /api/review-queue edge cases", () => {
	it("redacts secrets in instructions and returns raw text for the client to escape", async () => {
		const res = await raw(server.port, "/api/review-queue");
		expect(res.status).toBe(200);
		expect(res.text).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd");
		expect(res.headers["content-type"]).toContain("application/json");
	});

	it("still answers in read-only mode, ignores unknown parameters and treats an empty value as unset", async () => {
		expect((await raw(server.port, "/api/review-queue?foo=bar&limit=")).status).toBe(200);
	});

	it("does not match a trailing slash or a sub-path", async () => {
		expect((await raw(server.port, "/api/review-queue/")).status).toBe(404);
		expect((await raw(server.port, "/api/review-queue/x")).status).toBe(404);
	});
});
