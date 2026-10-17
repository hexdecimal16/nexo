import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMemory, addPlaybookItem, type Db, enqueueLearnJob, insertRun, listLearnJobs, listMemories, listPlaybookItems, openDb, publishPlaybook, RunDir, supersedeMemory } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { runRow } from "../../store/test/fixtures.ts";
import type { LearnJobsResponse, MemoryDetailResponse, MemoryListResponse, PlaybookListResponse, PlaybookResponse, PlaybookRetireResponse } from "../public/lib/api-types.ts";
import { startWebServer, type WebServer } from "../src/index.ts";
import { raw } from "./http.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const redact = createRedactor();
let db: Db;
let server: WebServer;
let readOnly: WebServer;
let home: string;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "nexo-web-learning-"));
	db = openDb(join(home, "nexo.db"));
	server = await startWebServer({ db, redact, port: 0, learning: { enabled: true } });
	readOnly = await startWebServer({ db, redact, port: 0, readOnly: { message: "config invalid", hint: null } });
});
afterAll(async () => {
	await server.close();
	await readOnly.close();
});

const post = (s: WebServer, path: string, body?: unknown) =>
	raw(s.port, path, { method: "POST", headers: { "x-nexo-token": s.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("learning API", () => {
	it("lists memories with filters and shows the history of a replaced memory", async () => {
		const old = addMemory(db, { scope: "user", type: "preference", content: "Tabs", importance: 0.5, source: "ace" }, redact, NOW);
		const next = supersedeMemory(db, old.id, { content: "Two spaces" }, "ace", redact, NOW);
		addMemory(db, { scope: "skill:ci", type: "lesson", content: "<script>alert(1)</script>", importance: 1, source: "human" }, redact, NOW);
		const live = (await raw(server.port, "/api/memories?scope=user")).json() as MemoryListResponse;
		expect(live.memories.map((m) => m.content)).toEqual(["Two spaces"]);
		const all = (await raw(server.port, "/api/memories?all=1")).json() as MemoryListResponse;
		expect(all.memories).toHaveLength(3);
		const detail = (await raw(server.port, `/api/memories/${next.id}`)).json() as MemoryDetailResponse;
		expect(detail.history.map((m) => m.content)).toEqual(["Tabs"]);
		expect((await raw(server.port, "/api/memories?scope=team")).status).toBe(400);
		expect((await raw(server.port, "/api/memories?limit=abc")).status).toBe(400);
		expect((await raw(server.port, "/api/memories/01ZZZZZZZZZZZZZZZZZZZZZZZZ")).status).toBe(404);
	});

	it("retires a human memory as a user action, with the token, and refuses without it or read-only", async () => {
		const human = addMemory(db, { scope: "global", type: "lesson", content: "Never deploy on Fridays", importance: 1, source: "human" }, redact, NOW);
		expect((await raw(server.port, `/api/memories/${human.id}/retire`, { method: "POST" })).status).toBe(403);
		expect((await post(readOnly, `/api/memories/${human.id}/retire`)).status).toBe(400);
		const res = await post(server, `/api/memories/${human.id}/retire`);
		expect(res.status).toBe(200);
		expect(res.json().memory).toMatchObject({ id: human.id, retiredAt: expect.any(String) });
		expect((await post(server, `/api/memories/${human.id}/retire`)).json().error.code).toBe("CONFLICT");
		expect((await raw(server.port, `/api/memories/${human.id}/retire`, { method: "GET" })).status).toBe(405);
	});

	it("lists playbooks, shows items with history and versions, and retires a human item with a manual version", async () => {
		addPlaybookItem(db, { skill: "deploy", content: "Ask before force-pushing", source: "human" }, redact, NOW);
		addPlaybookItem(db, { skill: "deploy", content: "Tag releases", source: "ace" }, redact, NOW);
		publishPlaybook(db, "deploy", "ace", NOW);
		const list = (await raw(server.port, "/api/playbooks")).json() as PlaybookListResponse;
		expect(list.playbooks).toContainEqual({ skill: "deploy", activeItems: 2, version: 1, origin: "ace" });
		const pb = (await raw(server.port, "/api/playbooks/deploy")).json() as PlaybookResponse;
		expect(pb.items.map((i) => [i.key, i.source, i.history.map((h) => h.action)])).toEqual([
			["k001", "human", ["add"]],
			["k002", "ace", ["add"]],
		]);
		const retired = (await post(server, "/api/playbooks/deploy/items/k001/retire")).json() as PlaybookRetireResponse;
		expect(retired.item).toMatchObject({ status: "retired", history: [{ action: "add" }, { action: "retire", actor: "user" }] });
		expect(retired.version).toMatchObject({ version: 2, origin: "manual" });
		const after = (await raw(server.port, "/api/playbooks/deploy?all=1")).json() as PlaybookResponse;
		expect(after.versions.map((v) => [v.version, v.status])).toEqual([
			[2, "active"],
			[1, "retired"],
		]);
		expect((await raw(server.port, "/api/playbooks/Bad%20Name")).status).toBe(400);
		expect((await post(server, "/api/playbooks/deploy/items/k404/retire")).status).toBe(404);
	});

	it("leaves the item active when its playbook version cannot be published", async () => {
		addPlaybookItem(db, { skill: "release", content: "Bump the version first", source: "human" }, redact, NOW);
		publishPlaybook(db, "release", "manual", NOW);
		db.exec("CREATE TRIGGER no_release_versions BEFORE INSERT ON artifacts WHEN NEW.name = 'release' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
		try {
			expect((await post(server, "/api/playbooks/release/items/k001/retire")).status).toBe(500);
			expect(listPlaybookItems(db, "release").map((i) => [i.key, i.status])).toEqual([["k001", "active"]]);
		} finally {
			db.exec("DROP TRIGGER no_release_versions");
		}
	});

	it("lists learn jobs with counts and validates the status filter", async () => {
		enqueueLearnJob(db, { runId: "r-jobs", trigger: "run_end" }, NOW);
		const jobs = (await raw(server.port, "/api/learn/jobs?status=pending")).json() as LearnJobsResponse;
		expect(jobs.counts.pending).toBeGreaterThanOrEqual(1);
		expect(jobs.jobs.every((j) => j.status === "pending")).toBe(true);
		expect((await raw(server.port, "/api/learn/jobs?status=done")).status).toBe(400);
	});

	it("stores a human lesson and enqueues a job when a verdict comes in with learning on, and neither when off", async () => {
		const make = () => {
			const base = runRow({ status: "succeeded", instruction: "Ship it" });
			const dir = RunDir.create(join(home, "runs"), base.id, redact);
			const row = { ...base, dirPath: dir.root };
			insertRun(db, row);
			return row;
		};
		const on = make();
		expect((await post(server, `/api/runs/${on.id}/feedback`, { verdict: "not_done", comment: "missed the changelog" })).status).toBe(201);
		expect(listMemories(db, { scope: "user" }).some((m) => m.source === "human" && m.content.includes("missed the changelog"))).toBe(true);
		expect(listLearnJobs(db, { runId: on.id })).toHaveLength(1);
		const offServer = await startWebServer({ db, redact, port: 0 });
		try {
			const off = make();
			await post(offServer, `/api/runs/${off.id}/feedback`, { verdict: "not_done", comment: "also wrong" });
			expect(listLearnJobs(db, { runId: off.id })).toEqual([]);
		} finally {
			await offServer.close();
		}
	});
});

describe("learning API pagination", () => {
	it("pages memories with a cursor until every memory was seen once", async () => {
		const all = (await raw(server.port, "/api/memories?all=1&limit=200")).json() as MemoryListResponse;
		expect(all.memories.length).toBeGreaterThanOrEqual(3);
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page = (await raw(server.port, `/api/memories?all=1&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json() as MemoryListResponse;
			expect(page.memories.length).toBeLessThanOrEqual(2);
			seen.push(...page.memories.map((m) => m.id));
			cursor = page.nextCursor;
			pages++;
		} while (cursor);
		expect(pages).toBeGreaterThan(1);
		expect(seen).toEqual(all.memories.map((m) => m.id));
		expect((await raw(server.port, "/api/memories?cursor=nope")).status).toBe(400);
	});

	it("pages learn jobs with a cursor", async () => {
		enqueueLearnJob(db, { runId: "r-jobs-page", trigger: "run_end" }, NOW);
		const first = (await raw(server.port, "/api/learn/jobs?limit=1")).json() as LearnJobsResponse;
		expect(first.jobs).toHaveLength(1);
		expect(first.nextCursor).toBeTruthy();
		const second = (await raw(server.port, `/api/learn/jobs?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).json() as LearnJobsResponse;
		expect(second.jobs).toHaveLength(1);
		expect(second.jobs[0]?.id).not.toBe(first.jobs[0]?.id);
		expect(second.counts).toEqual(first.counts);
	});
});
