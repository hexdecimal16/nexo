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
	db = openDb(join(mkdtempSync(join(tmpdir(), "nexo-web-rq-")), "nexo.db"));
	const now = new Date().toISOString();
	insertRun(db, runRow({ id: "ok-run", status: "succeeded", startedAt: now, instruction: "Tidy the notes" }));
	insertRun(db, runRow({ id: "bad-run", status: "failed", startedAt: now, instruction: "Deploy the site", error: { code: "PROVIDER_AUTH", message: "x", retryable: false } }));
	server = await startWebServer({ db, redact: createRedactor(), port: 0 });
});
afterAll(async () => {
	await server.close();
});

describe("GET /api/review-queue", () => {
	it("lists unreviewed runs worst first", async () => {
		const res = await raw(server.port, "/api/review-queue");
		expect(res.status).toBe(200);
		const body = res.json() as { items: { runId: string; failureMode: string; errorCode: string | null }[] };
		expect(body.items.map((i) => i.runId)).toEqual(["bad-run", "ok-run"]);
		expect(body.items[0]).toMatchObject({ failureMode: "failed", errorCode: "PROVIDER_AUTH" });
	});

	it("applies limit and rejects bad numbers with 400", async () => {
		expect(((await raw(server.port, "/api/review-queue?limit=1")).json() as { items: unknown[] }).items).toHaveLength(1);
		for (const q of ["limit=0", "limit=abc", "days=-1", "days=1.5"]) {
			const res = await raw(server.port, `/api/review-queue?${q}`);
			expect(res.status, q).toBe(400);
			expect(res.json().error.code).toBe("INVALID_REQUEST");
		}
	});

	it("refuses other methods", async () => {
		const res = await raw(server.port, "/api/review-queue", { method: "POST", headers: { "x-nexo-token": server.token } });
		expect(res.status).toBe(405);
	});
});
