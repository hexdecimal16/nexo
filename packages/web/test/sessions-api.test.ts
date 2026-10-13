import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertRun, openDb, recordFeedback, upsertSessionRow } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { runRow } from "../../store/test/fixtures.ts";
import type { RunListResponse, SessionListResponse } from "../public/lib/api-types.ts";
import { startWebServer, type WebServer } from "../src/index.ts";
import { raw } from "./http.ts";

let server: WebServer;
const ids = { oneShot: "", turn1: "", turn2: "" };

beforeAll(async () => {
	const db = openDb(":memory:");
	const session = (id: string, updatedAt: string, title: string) =>
		upsertSessionRow(db, { id, title, cwd: "/w", status: "active", budgetUsd: 5, costUsd: 0.4, turns: 2, createdAt: "2026-10-10T00:00:00.000Z", updatedAt, dirPath: `/tmp/${id}` });
	session("older", "2026-10-10T01:00:00.000Z", "Older chat");
	session("newer", "2026-10-10T02:00:00.000Z", "Newer chat");
	const oneShot = runRow({ status: "succeeded", startedAt: "2026-10-10T00:00:01.000Z" });
	const turn1 = runRow({ status: "succeeded", sessionId: "newer", turnIndex: 1, startedAt: "2026-10-10T00:00:02.000Z" });
	const turn2 = runRow({ status: "failed", sessionId: "newer", turnIndex: 2, startedAt: "2026-10-10T00:00:03.000Z" });
	for (const row of [oneShot, turn1, turn2]) insertRun(db, row);
	recordFeedback(db, { runId: turn1.id, verdict: "done", comment: "", redact: createRedactor(), nowIso: "2026-10-10T03:00:00.000Z" });
	Object.assign(ids, { oneShot: oneShot.id, turn1: turn1.id, turn2: turn2.id });
	server = await startWebServer({ db, redact: createRedactor(), port: 0 });
});
afterAll(async () => {
	await server.close();
});

describe("GET /api/sessions", () => {
	it("lists sessions newest update first with turn aggregates", async () => {
		const res = await raw(server.port, "/api/sessions");
		expect(res.status).toBe(200);
		const body = res.json() as SessionListResponse;
		expect(body.sessions.map((s) => s.id)).toEqual(["newer", "older"]);
		expect(body.sessions[0]).toEqual({
			id: "newer",
			title: "Newer chat",
			status: "active",
			turns: 2,
			costUsd: 0.4,
			budgetUsd: 5,
			createdAt: "2026-10-10T00:00:00.000Z",
			updatedAt: "2026-10-10T02:00:00.000Z",
			lastTurn: { runId: ids.turn2, status: "failed", startedAt: "2026-10-10T00:00:03.000Z" },
			unreviewedTurns: 1,
		});
		expect(body.sessions[1]).toMatchObject({ lastTurn: null, unreviewedTurns: 0 });
	});

	it("honours limit and rejects bad limits with 400 INVALID_REQUEST", async () => {
		expect(((await raw(server.port, "/api/sessions?limit=1")).json() as SessionListResponse).sessions).toHaveLength(1);
		expect((await raw(server.port, "/api/sessions?limit=200")).status).toBe(200);
		for (const limit of ["0", "201", "x", "-1", "1.5"]) {
			const res = await raw(server.port, `/api/sessions?limit=${limit}`);
			expect(res.status, limit).toBe(400);
			expect(res.json().error.code, limit).toBe("INVALID_REQUEST");
		}
	});

	it("is GET only", async () => {
		const res = await raw(server.port, "/api/sessions", { method: "POST", headers: { "content-type": "application/json", "x-nexo-token": server.token }, body: "{}" });
		expect(res.status).toBe(405);
	});
});

describe("GET /api/runs oneShot", () => {
	it("leaves out session turns only when asked, and never for the review queue or a session filter", async () => {
		const runs = async (q: string) => ((await raw(server.port, `/api/runs${q}`)).json() as RunListResponse).runs.map((r) => r.id);
		expect(await runs("?oneShot=true")).toEqual([ids.oneShot]);
		expect(await runs("")).toEqual([ids.turn2, ids.turn1, ids.oneShot]);
		expect(await runs("?reviewed=false")).toEqual([ids.turn2, ids.oneShot]);
		expect(await runs("?session=newer")).toEqual([ids.turn2, ids.turn1]);
		expect((await raw(server.port, "/api/runs?oneShot=maybe")).status).toBe(400);
	});
});
