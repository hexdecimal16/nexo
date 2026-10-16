import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type Db,
	ensureManualArtifact,
	getActiveArtifact,
	insertCandidateArtifact,
	insertOptimCandidate,
	insertOptimRun,
	insertRun,
	insertScore,
	openDb,
	type OptimRunRow,
} from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { runRow, scoreRow } from "../../store/test/fixtures.ts";
import type { OptimDetailResponse, OptimListResponse, OptimReport } from "../public/lib/api-types.ts";
import { startWebServer, type WebServer } from "../src/index.ts";
import { raw } from "./http.ts";

const NOW = "2026-10-12T00:00:00.000Z";
let db: Db;
let server: WebServer;
let readOnly: WebServer;
let home: string;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "nexo-web-optim-"));
	db = openDb(join(home, "nexo.db"));
	server = await startWebServer({ db, redact: createRedactor(), port: 0, optimize: { minJudgeKappa: 0.6 } });
	readOnly = await startWebServer({ db, redact: createRedactor(), port: 0, readOnly: { message: "config invalid", hint: null } });
});
afterAll(async () => {
	await server.close();
	await readOnly.close();
});

const post = (s: WebServer, path: string) => raw(s.port, path, { method: "POST", headers: { "x-nexo-token": s.token, "content-type": "application/json" } });

/** A succeeded optimization of skill `name` with a report.json, whose best candidate is a new candidate version. */
function optimization(name: string, overrides: Partial<OptimRunRow> = {}): OptimRunRow {
	const base = ensureManualArtifact(db, "skill", name, `---\nname: ${name}\n---\nv1`, NOW);
	const best = insertCandidateArtifact(db, "skill", name, `---\nname: ${name}\n---\nv2 <script>alert(1)</script>`, base.id, NOW);
	const id = `01OPT${name.toUpperCase().replace(/-/g, "")}`;
	const dir = join(home, "optim", id);
	mkdirSync(dir, { recursive: true });
	const run: OptimRunRow = {
		id,
		target: `skill:${name}`,
		status: "succeeded",
		stopReason: "patience",
		budgetUsd: 2,
		budgetRollouts: null,
		spentUsd: 0.4,
		rollouts: 30,
		merge: false,
		seed: 7,
		baseArtifactId: base.id,
		bestArtifactId: best.id,
		dirPath: dir,
		reportRef: "report.json",
		judgeKey: "google/gemini-x",
		judgeOnly: false,
		holdoutBefore: 0.3,
		holdoutAfter: 0.9,
		promotion: null,
		replacedArtifactId: null,
		promotedAt: null,
		pid: null,
		error: null,
		createdAt: NOW,
		endedAt: NOW,
		mode: "gepa",
		caseId: null,
		climbOutcome: null,
		...overrides,
	};
	insertOptimRun(db, run);
	insertOptimCandidate(db, { id: `${id}-seed`, optimRunId: id, artifactId: base.id, parentIds: [], iteration: 0, origin: "seed", component: null, minibatch: null, perCase: {}, meanScore: 0.3, meanCostUsd: 0.01, accepted: true, createdAt: NOW });
	insertOptimCandidate(db, { id: `${id}-c1`, optimRunId: id, artifactId: best.id, parentIds: [`${id}-seed`], iteration: 1, origin: "reflect", component: "body", minibatch: { caseIds: ["a"], parent: [{ quality: 0.3, costUsd: 0.01 }], child: [{ quality: 0.9, costUsd: 0.01 }] }, perCase: {}, meanScore: 0.9, meanCostUsd: 0.01, accepted: true, createdAt: NOW });
	const report: Partial<OptimReport> = { optimRunId: id, target: run.target, improved: true, holdout: { cases: [], before: { quality: 0.3, costUsd: 0.01 }, after: { quality: 0.9, costUsd: 0.01 }, wins: 1, losses: 0, ties: 0 }, diff: [{ op: "add", text: "v2" }] };
	writeFileSync(join(dir, "report.json"), JSON.stringify(report));
	return run;
}

describe("optimization API", () => {
	it("lists optimizations and shows one with its candidates, report and approval state", async () => {
		const run = optimization("lint-fix");
		const list = (await raw(server.port, "/api/optim")).json() as OptimListResponse;
		expect(list.runs.find((r) => r.id === run.id)).toMatchObject({ target: "skill:lint-fix", baseVersion: 1, bestVersion: 2 });
		const detail = (await raw(server.port, `/api/optim/${run.id}`)).json() as OptimDetailResponse;
		expect(detail.candidates.map((c) => [c.origin, c.version, c.artifactStatus])).toEqual([
			["seed", 1, "active"],
			["reflect", 2, "candidate"],
		]);
		expect(detail.report?.holdout.wins).toBe(1);
		expect(detail.promotion).toEqual({ allowed: true, error: null, kappa: null });
		expect((await raw(server.port, "/api/optim/01NOSUCHOPTIM")).status).toBe(404);
		expect((await raw(server.port, `/api/optim/${run.id}/approve`)).status).toBe(405);
	});

	it("approves with the token only, then refuses a second approval with 409", async () => {
		const run = optimization("docs-fix");
		expect((await raw(server.port, `/api/optim/${run.id}/approve`, { method: "POST" })).status).toBe(403);
		expect((await post(readOnly, `/api/optim/${run.id}/approve`)).status).toBe(400);
		const res = await post(server, `/api/optim/${run.id}/approve`);
		expect(res.status).toBe(200);
		expect(res.json()).toMatchObject({ promoted: { version: 2, status: "active", origin: "gepa" }, replaced: { version: 1, status: "retired" }, run: { promotion: "approved" } });
		expect(getActiveArtifact(db, "skill", "docs-fix")?.version).toBe(2);
		const again = await post(server, `/api/optim/${run.id}/approve`);
		expect(again.status).toBe(409);
		expect(again.json().error.code).toBe("CONFLICT");
	});

	it("refuses approval with 403 and the runs to review when the evidence is judge-only and the judge is uncalibrated", async () => {
		const run = optimization("test-fix", { judgeOnly: true });
		const judged = runRow({ status: "succeeded" });
		insertRun(db, judged);
		insertScore(db, scoreRow(judged.id, { model: "google/gemini-x" }));
		const detail = (await raw(server.port, `/api/optim/${run.id}`)).json() as OptimDetailResponse;
		expect(detail.promotion).toMatchObject({ allowed: false, error: { code: "FORBIDDEN" } });
		const res = await post(server, `/api/optim/${run.id}/approve`);
		expect(res.status).toBe(403);
		const body = res.json().error;
		expect(body.message).toMatch(/Promotion refused: the holdout evidence comes only from the judge/);
		expect(body.context.runsToReview).toContain(judged.id);
		expect(body.hint).toContain(judged.id);
		expect(getActiveArtifact(db, "skill", "test-fix")?.version).toBe(1);
	});
});

describe("eval-case routes", () => {
	const proposed = (id: string, input: string) =>
		db.prepare("INSERT INTO eval_cases (id, target, source_run_id, input, split, created_at, origin, status, mined_from_json) VALUES (?, 'skill:web-x', ?, ?, 'pareto', ?, 'mined', 'proposed', '[\"a\",\"b\",\"c\"]')").run(id, `SRC${id}`, input, NOW);

	it("lists proposed cases without their golden or cluster ids", async () => {
		proposed("01MINEDA", "Summarize <b>PRs</b>");
		const res = await raw(server.port, "/api/eval-cases?status=proposed");
		expect(res.status).toBe(200);
		const body = res.json() as { cases: Record<string, unknown>[] };
		const item = body.cases.find((c) => c.id === "01MINEDA");
		expect(item).toEqual({ id: "01MINEDA", target: "skill:web-x", input: "Summarize <b>PRs</b>", origin: "mined", status: "proposed", clusterSize: 3, createdAt: NOW });
	});

	it("refuses an unknown status filter", async () => {
		expect((await raw(server.port, "/api/eval-cases?status=bogus")).status).toBe(400);
	});

	it("accepts and dismisses, with 404 for unknown ids and 409 for repeat decisions", async () => {
		proposed("01MINEDB", "b");
		proposed("01MINEDC", "c");
		expect((await post(server, "/api/eval-cases/01MINEDB/accept")).status).toBe(200);
		expect((await post(server, "/api/eval-cases/01MINEDC/dismiss")).status).toBe(200);
		expect((await post(server, "/api/eval-cases/01MINEDB/dismiss")).status).toBe(409);
		expect((await post(server, "/api/eval-cases/NOPE/accept")).status).toBe(404);
		expect((await raw(server.port, "/api/eval-cases/01MINEDB/accept")).status).toBe(405);
		expect((await post(readOnly, "/api/eval-cases/01MINEDC/accept")).status).not.toBe(200);
	});
});
