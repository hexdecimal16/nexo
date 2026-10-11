import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertRun, insertSpan, latestFeedback, listFeedback } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { runRow, spanRow } from "../../store/test/fixtures.ts";
import type { CostResponse, DirListing, MetaResponse, RunDetailResponse, RunListResponse, SpanNode, SpanTreeResponse } from "../public/lib/api-types.ts";
import { MAX_FILE_PREVIEW_BYTES, startWebServer, type WebServer } from "../src/index.ts";
import { buildFixture, type Fixture, XSS } from "./fixtures.ts";
import { raw } from "./http.ts";

let fx: Fixture;
let server: WebServer;

beforeAll(async () => {
	fx = buildFixture();
	server = await startWebServer({ db: fx.db, redact: createRedactor(), port: 0, now: () => new Date("2026-10-11T00:00:00.000Z") });
});
afterAll(async () => {
	await server.close();
	fx.db.close();
	rmSync(fx.home, { recursive: true, force: true });
});

const get = (path: string) => raw(server.port, path);
const post = (path: string, body: unknown, token: string | null = server.token) =>
	raw(server.port, path, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token === null ? {} : { "x-nexo-token": token }) },
		body: JSON.stringify(body),
	});

function names(nodes: SpanNode[]): unknown[] {
	return nodes.map((n) => (n.children.length ? [n.span.name, names(n.children)] : n.span.name));
}

describe("GET /api/runs", () => {
	it("lists root runs newest first with summaries", async () => {
		const res = await get("/api/runs");
		expect(res.status).toBe(200);
		const body = res.json() as RunListResponse;
		expect(body.runs.map((r) => r.id)).toEqual([fx.running.id, fx.root.id, fx.deleted.id]);
		expect(body.runs[1]).toMatchObject({ skill: "report", childCount: 1, verdict: null, costUsd: 0.03 });
		expect(body.nextCursor).toBeNull();
	});

	it("paginates with limit and cursor", async () => {
		const first = (await get("/api/runs?limit=2")).json() as RunListResponse;
		expect(first.runs).toHaveLength(2);
		const second = (await get(`/api/runs?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).json() as RunListResponse;
		expect(second.runs.map((r) => r.id)).toEqual([fx.deleted.id]);
		expect(second.nextCursor).toBeNull();
	});

	it("filters by session and reports each turn's session", async () => {
		const body = (await get("/api/runs?session=01SESSION0000000000000001")).json() as RunListResponse;
		expect(body.runs.map((r) => r.id)).toEqual([fx.running.id]);
		expect(body.runs[0]).toMatchObject({ sessionId: "01SESSION0000000000000001", turnIndex: 2, sessionTitle: `Chat ${XSS}` });
		expect(((await get("/api/runs?session=unknown")).json() as RunListResponse).runs).toEqual([]);
		const detail = (await get(`/api/runs/${fx.running.id}`)).json() as RunDetailResponse;
		expect(detail.run).toMatchObject({ sessionId: "01SESSION0000000000000001", turnIndex: 2 });
	});

	it("filters by status and skill", async () => {
		expect(((await get("/api/runs?status=running")).json() as RunListResponse).runs.map((r) => r.id)).toEqual([fx.running.id]);
		expect(((await get("/api/runs?skill=report")).json() as RunListResponse).runs.map((r) => r.id)).toEqual([fx.root.id]);
		expect(((await get("/api/runs?since=2026-10-10T10:30:00Z")).json() as RunListResponse).runs.map((r) => r.id)).toEqual([fx.running.id]);
	});

	it("rejects bad parameters with 400 INVALID_REQUEST", async () => {
		for (const q of ["limit=0", "limit=abc", "limit=201", "status=done", "reviewed=yes", "since=last-week", "cursor=%%%", "scored=yes"]) {
			const res = await get(`/api/runs?${q}`);
			expect(res.status, q).toBe(400);
			expect(res.json().error.code, q).toBe("INVALID_REQUEST");
		}
	});
});

describe("GET /api/runs/{id}", () => {
	it("returns run.json, child summaries and feedback", async () => {
		const res = await get(`/api/runs/${fx.root.id}`);
		const body = res.json() as RunDetailResponse;
		expect(body.run.instruction).toBe(`Summarize ${XSS}`);
		expect(body.runJson?.model).toMatchObject({ effort: "low", source: "skill" });
		expect(body.dirMissing).toBe(false);
		expect(body.children.map((c) => [c.id, c.status, c.costUnknown])).toEqual([[fx.child.id, "failed", true]]);
		expect(body.feedback).toEqual([]);
	});

	it("serves a run that is still running", async () => {
		const body = (await get(`/api/runs/${fx.running.id}`)).json() as RunDetailResponse;
		expect(body.run.status).toBe("running");
		expect(body.runJson?.endedAt).toBeNull();
		const tree = (await get(`/api/runs/${fx.running.id}/spans`)).json() as SpanTreeResponse;
		expect(tree.roots[0]?.span).toMatchObject({ status: "running", endedAt: null });
	});

	it("reports a deleted run directory instead of failing", async () => {
		const body = (await get(`/api/runs/${fx.deleted.id}`)).json() as RunDetailResponse;
		expect(body).toMatchObject({ dirMissing: true, runJson: null });
		expect(body.run.instruction).toBe("gone");
		const files = await get(`/api/runs/${fx.deleted.id}/files/`);
		expect(files.status).toBe(404);
		expect(files.json().error.hint).toContain("nexo reindex");
	});

	it("404s an unknown run", async () => {
		const res = await get("/api/runs/01UNKNOWN0000000000000000");
		expect(res.status).toBe(404);
		expect(res.json()).toEqual({
			error: { code: "NOT_FOUND", message: "Run 01UNKNOWN0000000000000000 does not exist", retryable: false, hint: null, context: { runId: "01UNKNOWN0000000000000000" } },
		});
	});
});

describe("GET /api/runs/{id}/spans", () => {
	it("returns the tree with subagent spans inline", async () => {
		const tree = (await get(`/api/runs/${fx.root.id}/spans`)).json() as SpanTreeResponse;
		expect(tree).toMatchObject({ total: 7, truncated: false });
		expect(names(tree.roots)).toEqual([["skill:report", ["fast", ["spawn", [["a", [["run", ["fast", "bash"]]]]]]]]]);
	});

	it("returns a child run's own subtree and single spans by id", async () => {
		const tree = (await get(`/api/runs/${fx.child.id}/spans`)).json() as SpanTreeResponse;
		expect(names(tree.roots)).toEqual([["run", ["fast", "bash"]]]);
		expect((await get(`/api/runs/${fx.root.id}/spans/${fx.ids.childLlmSpan}`)).json().span.payloadRef).toBe("tool_outputs/big.txt");
		expect((await get(`/api/runs/${fx.child.id}/spans/${fx.ids.runSpan}`)).status).toBe(404);
	});

	it("caps a huge tree and keeps long attributes as previews", async () => {
		const big = runRow({ status: "succeeded", startedAt: "2026-10-01T00:00:00.000Z" });
		insertRun(fx.db, big);
		for (let i = 0; i < 5100; i++) insertSpan(fx.db, spanRow(big.id, { status: "ok", attrs: { result: i === 0 ? "z".repeat(10_000) : "ok" } }));
		const tree = (await get(`/api/runs/${big.id}/spans`)).json() as SpanTreeResponse;
		expect(tree).toMatchObject({ total: 5100, truncated: true });
		expect(tree.roots).toHaveLength(5000);
		const first = tree.roots.find((n) => n.attrsTruncated);
		expect(String(first?.span.attrs.result).length).toBeLessThan(4100);
		const full = (await get(`/api/runs/${big.id}/spans/${first?.span.id}`)).json();
		expect(full.span.attrs.result).toHaveLength(10_000);
	});
});

describe("GET /api/runs/{id}/files/{path}", () => {
	it("lists directories with directories first", async () => {
		const listing = (await get(`/api/runs/${fx.root.id}/files/`)).json() as DirListing;
		expect(listing.path).toBe("");
		expect(listing.entries.filter((e) => e.kind === "dir").map((e) => e.name)).toEqual(["artifacts", "changes", "context", "scores", "subagents", "tool_outputs", "workspace"]);
		expect(listing.entries.find((e) => e.name === "run.json")).toMatchObject({ kind: "file", path: "run.json" });
		const changes = (await get(`/api/runs/${fx.root.id}/files/changes`)).json() as DirListing;
		expect(changes.entries.map((e) => e.path)).toEqual(["changes/after", "changes/changes.diff"]);
	});

	it("reports symlinks without following them", async () => {
		const artifacts = (await get(`/api/runs/${fx.root.id}/files/artifacts`)).json() as DirListing;
		expect(artifacts.entries).toEqual([{ name: "escape.txt", path: "artifacts/escape.txt", kind: "symlink", size: 0 }]);
	});

	it("refuses a FIFO instead of blocking the server on it", async () => {
		const fifo = join(fx.root.dirPath, "context", "pipe");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		const listing = (await get(`/api/runs/${fx.root.id}/files/context`)).json() as DirListing;
		expect(listing.entries).toEqual([{ name: "pipe", path: "context/pipe", kind: "other", size: 0 }]);
		const res = await get(`/api/runs/${fx.root.id}/files/context/pipe`);
		expect(res.status).toBe(403);
		expect(res.json().error).toMatchObject({ code: "FORBIDDEN", message: '"context/pipe" is not a regular file' });
		expect((await get("/api/runs")).status).toBe(200);
		rmSync(fifo);
	});

	it("serves a trajectory.jsonl that grows during the download with a consistent content-length", async () => {
		const file = join(fx.running.dirPath, "trajectory.jsonl");
		const line = `${JSON.stringify({ id: "s", note: "x".repeat(200) })}\n`;
		writeFileSync(file, line.repeat(8000));
		const pending = get(`/api/runs/${fx.running.id}/files/trajectory.jsonl?full=1`);
		for (let i = 0; i < 20; i++) {
			appendFileSync(file, line.repeat(500));
			await new Promise((r) => setImmediate(r));
		}
		const res = await pending;
		expect(res.status).toBe(200);
		expect(Buffer.byteLength(res.text)).toBe(Number(res.headers["content-length"]));
		expect(Number(res.headers["content-length"])).toBeGreaterThanOrEqual(line.length * 8000);
		expect(readFileSync(file, "utf8").startsWith(res.text)).toBe(true);
		expect(res.text.endsWith("\n")).toBe(true);
	});

	it("serves agent-written HTML as sandboxed plain text", async () => {
		const res = await get(`/api/runs/${fx.root.id}/files/changes/after/x.html`);
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
		expect(res.headers["content-security-policy"]).toContain("sandbox");
		expect(res.text).toBe(XSS);
	});

	it("truncates files over 1 MiB unless full=1", async () => {
		const path = `/api/runs/${fx.child.id}/files/tool_outputs/big.txt`;
		const preview = await get(path);
		expect(preview.text).toHaveLength(MAX_FILE_PREVIEW_BYTES);
		expect(preview.headers["x-nexo-truncated"]).toBe(String(2 * 1024 * 1024));
		const full = await get(`${path}?full=1`);
		expect(full.text).toHaveLength(2 * 1024 * 1024);
		expect(full.headers["x-nexo-truncated"]).toBeUndefined();
	});

	it("confines paths to the run directory", async () => {
		for (const path of ["..%2F..%2Fsecret.txt", "%2e%2e%2F%2e%2e%2Fsecret.txt", "artifacts/escape.txt", "%2Fetc%2Fpasswd"]) {
			const res = await get(`/api/runs/${fx.root.id}/files/${path}`);
			expect(res.status, path).toBe(403);
			expect(res.json().error.code, path).toBe("FORBIDDEN");
		}
		// The URL parser resolves literal and %2e dot segments before routing, so these never reach the files route.
		for (const path of ["../../secret.txt", "%2e%2e/%2e%2e/secret.txt"]) {
			const res = await get(`/api/runs/${fx.root.id}/files/${path}`);
			expect(res.status, path).toBe(404);
			expect(res.text).not.toContain("outside the run");
		}
		expect((await get(`/api/runs/${fx.root.id}/files/nope.txt`)).status).toBe(404);
		expect((await get(`/api/runs/${fx.root.id}/files/a%00b`)).status).toBe(400);
		expect((await get(`/api/runs/${fx.root.id}/files/%E0%A4%A`)).status).toBe(400);
	});
});

describe("POST /api/runs/{id}/feedback", () => {
	it("records a verdict for the root and for a subagent run", async () => {
		const res = await post(`/api/runs/${fx.root.id}/feedback`, { verdict: "not_done", comment: "missed the totals" });
		expect(res.status).toBe(201);
		expect(res.json().feedback).toMatchObject({ runId: fx.root.id, verdict: "not_done", comment: "missed the totals", createdAt: "2026-10-11T00:00:00.000Z" });
		expect((await post(`/api/runs/${fx.child.id}/feedback`, { verdict: "done" })).status).toBe(201);
		const detail = (await get(`/api/runs/${fx.root.id}`)).json() as RunDetailResponse;
		expect(Object.keys(detail.childFeedback)).toEqual([fx.child.id]);
		expect(detail.childFeedback[fx.child.id]).toMatchObject({ verdict: "done", runId: fx.child.id });
		expect(JSON.parse(readFileSync(join(fx.root.dirPath, "run.json"), "utf8")).humanVerdict.verdict).toBe("not_done");
		const reviewed = (await get("/api/runs?reviewed=true")).json() as RunListResponse;
		expect(reviewed.runs.map((r) => [r.id, r.verdict])).toEqual([[fx.root.id, "not_done"]]);
		const queue = (await get("/api/runs?reviewed=false")).json() as RunListResponse;
		expect(queue.runs.map((r) => r.id)).toContain(fx.deleted.id);
		expect(queue.runs.map((r) => r.id)).not.toContain(fx.root.id);
		expect(queue.runs.map((r) => r.id)).not.toContain(fx.running.id);
	});

	it("rejects a bad verdict, an unknown run, a running run, and a missing or wrong token", async () => {
		const cases: [string, unknown, string | null, number, string][] = [
			[fx.root.id, { verdict: "meh" }, server.token, 400, "INVALID_REQUEST"],
			[fx.root.id, { comment: "no verdict" }, server.token, 400, "INVALID_REQUEST"],
			[fx.root.id, { verdict: "done", comment: 7 }, server.token, 400, "INVALID_REQUEST"],
			["01UNKNOWN0000000000000000", { verdict: "done" }, server.token, 404, "NOT_FOUND"],
			[fx.running.id, { verdict: "done" }, server.token, 409, "CONFLICT"],
			[fx.root.id, { verdict: "done" }, null, 403, "FORBIDDEN"],
			[fx.root.id, { verdict: "done" }, "wrong", 403, "FORBIDDEN"],
		];
		const before = listFeedback(fx.db, fx.root.id).length;
		for (const [id, body, token, status, code] of cases) {
			const res = await post(`/api/runs/${id}/feedback`, body, token);
			expect([res.status, res.json().error.code]).toEqual([status, code]);
		}
		expect(listFeedback(fx.db, fx.root.id)).toHaveLength(before);
	});

	it("keeps every verdict when submissions race and mirrors the newest into run.json", async () => {
		const before = listFeedback(fx.db, fx.child.id).length;
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) => post(`/api/runs/${fx.child.id}/feedback`, { verdict: i % 2 ? "done" : "not_done", comment: `#${i}` })),
		);
		expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
		expect(listFeedback(fx.db, fx.child.id)).toHaveLength(before + 10);
		const detail = (await get(`/api/runs/${fx.child.id}`)).json() as RunDetailResponse;
		expect(detail.feedback).toHaveLength(before + 10);
		const newest = latestFeedback(fx.db, fx.child.id);
		expect(JSON.parse(readFileSync(join(fx.child.dirPath, "run.json"), "utf8")).humanVerdict).toEqual({
			verdict: newest?.verdict,
			comment: newest?.comment,
			createdAt: newest?.createdAt,
		});
	});
});

describe("POST /api/runs/{id}/feedback when run.json cannot be mirrored", () => {
	it("answers a retryable 500 STORE_IO and keeps the feedback row", async () => {
		const dir = join(fx.home, "broken-run");
		mkdirSync(join(dir, "run.json"), { recursive: true });
		const broken = { ...runRow({ status: "succeeded" }), dirPath: dir };
		insertRun(fx.db, broken);
		const res = await post(`/api/runs/${broken.id}/feedback`, { verdict: "done" });
		expect(res.status).toBe(500);
		expect(res.json().error).toMatchObject({ code: "STORE_IO", retryable: true });
		expect(listFeedback(fx.db, broken.id)).toHaveLength(1);
	});
});

describe("GET /api/meta", () => {
	it("lists the run statuses and cost dimensions and reports a writable UI", async () => {
		const meta = (await get("/api/meta")).json() as MetaResponse;
		expect(meta).toEqual({
			runStatuses: ["running", "succeeded", "failed", "aborted", "budget_exceeded"],
			costDimensions: ["day", "model", "skill", "tier", "run"],
			readOnly: null,
		});
	});
});

describe("GET /api/costs", () => {
	it("groups LLM spend and counts unpriced calls", async () => {
		const body = (await get("/api/costs?by=model&since=2026-10-01")).json() as CostResponse;
		expect(body).toMatchObject({ by: "model", since: "2026-10-01", unknownCalls: 1 });
		expect(body.rows[0]).toMatchObject({ key: "faux/fast" });
		const byDay = (await get("/api/costs")).json() as CostResponse;
		expect(byDay).toMatchObject({ by: "day", since: "2026-09-11" });
		expect(byDay.rows.map((r) => r.key)).toContain("2026-10-10");
	});

	it("rejects unknown dimensions and bad dates", async () => {
		expect((await get("/api/costs?by=color")).json().error).toMatchObject({ code: "INVALID_REQUEST", hint: "Use one of day, model, skill, tier, run" });
		expect((await get("/api/costs?since=10/10/2026")).status).toBe(400);
		expect((await get("/api/costs?since=2026-02-30")).status).toBe(400);
	});
});
