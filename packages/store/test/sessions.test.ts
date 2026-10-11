import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRedactor, NexoError, REDACTED } from "@nexo/telemetry";
import {
	costReport,
	getRun,
	insertSpan,
	maxSessionTurn,
	getSessionRow,
	insertRun,
	listSessionRows,
	openDb,
	queryRuns,
	reindex,
	RunDir,
	type RunJson,
	SessionDir,
	type SessionJson,
	sessionRowFromJson,
	upsertSessionRow,
} from "../src/index.ts";
import { runRow, spanRow } from "./fixtures.ts";

const redact = createRedactor();

function sessionJson(id: string, overrides: Partial<SessionJson> = {}): SessionJson {
	return {
		id,
		title: "hello",
		cwd: "/w",
		workspace: "/w",
		model: null,
		effort: null,
		budgetUsd: 5,
		costUsd: 0.25,
		turns: 2,
		status: "active",
		createdAt: "2026-10-11T00:00:00.000Z",
		updatedAt: "2026-10-11T00:01:00.000Z",
		lastRunId: null,
		context: null,
		...overrides,
	};
}

describe("SessionDir", () => {
	it("writes session.json atomically and redacted, and round-trips the transcript", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-sessions-"));
		const dir = SessionDir.create(root, "s1", redact);
		dir.writeSessionJson(sessionJson("s1", { title: "key sk-ant-abcdefghijklmnopqrstuvwxyz0123" }));
		expect(existsSync(join(dir.root, "session.json.tmp"))).toBe(false);
		expect(dir.readSessionJson().title).toContain(REDACTED);

		dir.appendTranscript([
			{ type: "message", turnIndex: 1, message: { role: "user", content: "token sk-ant-abcdefghijklmnopqrstuvwxyz0123" } },
			{ type: "compaction", turnIndex: 2, summary: "s", replacedThroughTurn: 1 },
		]);
		appendFileSync(join(dir.root, "transcript.jsonl"), '{"type":"mess');
		const lines = dir.readTranscript();
		expect(lines).toHaveLength(2);
		expect(JSON.stringify(lines[0])).toContain(REDACTED);
		expect(readFileSync(join(dir.root, "transcript.jsonl"), "utf8")).not.toContain("sk-ant-abcdef");
		expect(lines[1]).toEqual({ type: "compaction", turnIndex: 2, summary: "s", replacedThroughTurn: 1 });
	});

	it("keeps opaque provider fields intact while redacting secrets in the transcript", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-sessions-"));
		const dir = SessionDir.create(root, "s1", redact);
		const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";
		const message = {
			role: "assistant",
			responseId: `resp-${secret}`,
			content: [
				{ type: "thinking", thinking: `thought ${secret}`, thinkingSignature: `sig-${secret}` },
				{ type: "text", text: `said ${secret}`, textSignature: `tsig-${secret}` },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: `echo ${secret}` }, thoughtSignature: `gsig-${secret}` },
			],
		};
		dir.appendTranscript([{ type: "message", turnIndex: 1, message }]);
		const back = dir.readTranscript()[0] as { message: typeof message };
		const [thinking, text, call] = back.message.content as Record<string, unknown>[];
		expect(thinking?.thinkingSignature).toBe(`sig-${secret}`);
		expect(text?.textSignature).toBe(`tsig-${secret}`);
		expect(call?.thoughtSignature).toBe(`gsig-${secret}`);
		expect(back.message.responseId).toBe(`resp-${secret}`);
		expect(thinking?.thinking).toBe(`thought ${REDACTED}`);
		expect(text?.text).toBe(`said ${REDACTED}`);
		expect(call?.arguments).toEqual({ command: `echo ${REDACTED}` });
	});

	it("open throws NOT_FOUND for a missing session", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-sessions-"));
		try {
			SessionDir.open(root, "nope", redact);
			expect.unreachable();
		} catch (error) {
			expect((error as NexoError).code).toBe("NOT_FOUND");
		}
	});
});

describe("sessions table", () => {
	it("upserts and lists sessions newest first", () => {
		const db = openDb(":memory:");
		upsertSessionRow(db, sessionRowFromJson(sessionJson("a", { updatedAt: "2026-10-11T00:00:01.000Z" }), "/d/a"));
		upsertSessionRow(db, sessionRowFromJson(sessionJson("b", { updatedAt: "2026-10-11T00:00:02.000Z" }), "/d/b"));
		upsertSessionRow(db, sessionRowFromJson(sessionJson("a", { updatedAt: "2026-10-11T00:00:03.000Z", turns: 3 }), "/d/a"));
		expect(listSessionRows(db).map((s) => s.id)).toEqual(["a", "b"]);
		expect(listSessionRows(db, { limit: 1 })).toHaveLength(1);
		expect(getSessionRow(db, "a")).toMatchObject({ turns: 3, budgetUsd: 5, costUsd: 0.25, status: "active", dirPath: "/d/a", cwd: "/w" });
		expect(getSessionRow(db, "zzz")).toBeUndefined();
	});

	it("filters runs by session and reports the turn and session title", () => {
		const db = openDb(":memory:");
		upsertSessionRow(db, sessionRowFromJson(sessionJson("s1", { title: "Chat" }), "/d/s1"));
		insertRun(db, runRow({ id: "r1", status: "succeeded", sessionId: "s1", turnIndex: 1 }));
		insertRun(db, runRow({ id: "r2", status: "succeeded", sessionId: "s1", turnIndex: 2 }));
		insertRun(db, runRow({ id: "r3", status: "succeeded" }));
		const page = queryRuns(db, { sessionId: "s1" });
		expect(page.runs.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
		expect(page.runs.find((r) => r.id === "r2")).toMatchObject({ sessionId: "s1", turnIndex: 2, sessionTitle: "Chat" });
		expect(queryRuns(db, {}).runs.find((r) => r.id === "r3")).toMatchObject({ sessionId: null, turnIndex: null, sessionTitle: null });
	});
});

describe("session run links", () => {
	it("reports the highest recorded turn of a session", () => {
		const db = openDb(":memory:");
		expect(maxSessionTurn(db, "s1")).toBe(0);
		insertRun(db, runRow({ sessionId: "s1", turnIndex: 2 }));
		insertRun(db, runRow({ id: "latest", sessionId: "s1", turnIndex: 5 }));
		insertRun(db, runRow({ sessionId: "s2", turnIndex: 9 }));
		expect(maxSessionTurn(db, "s1")).toBe(5);
	});

	it("counts compaction spans in the cost report", () => {
		const db = openDb(":memory:");
		const run = runRow({ status: "succeeded", startedAt: "2026-10-11T00:00:00.000Z" });
		insertRun(db, run);
		insertSpan(db, spanRow(run.id, { costUsd: 0.25, startedAt: "2026-10-11T00:00:01.000Z" }));
		insertSpan(db, spanRow(run.id, { kind: "compaction", costUsd: 0.5, startedAt: "2026-10-11T00:00:02.000Z" }));
		insertSpan(db, spanRow(run.id, { kind: "tool_call", costUsd: 9, startedAt: "2026-10-11T00:00:03.000Z" }));
		const report = costReport(db, { by: "model", since: "2026-10-11" });
		expect(report.totalUsd).toBeCloseTo(0.75, 10);
		expect(report.rows[0]).toMatchObject({ calls: 2 });
	});
});

describe("reindex sessions", () => {
	it("rebuilds the sessions table from session directories and run links from run.json", () => {
		const home = mkdtempSync(join(tmpdir(), "nexo-home-"));
		const runsRoot = join(home, "runs");
		const sessionsRoot = join(home, "sessions");
		const run = RunDir.create(runsRoot, "r1", redact);
		run.writeRunJson({
			id: "r1",
			parentRunId: null,
			rootRunId: "r1",
			instruction: "hi",
			skill: null,
			status: "succeeded",
			model: null,
			startedAt: "2026-10-11T00:00:00.000Z",
			endedAt: "2026-10-11T00:00:01.000Z",
			costUsd: 0.1,
			costUnknown: false,
			tokensIn: 1,
			tokensOut: 1,
			output: "",
			error: null,
			artifactSetId: null,
			configSnapshotHash: "h",
			workspace: "/w",
			taskGraphs: [],
			sessionId: "s1",
			turnIndex: 1,
		} satisfies RunJson);
		SessionDir.create(sessionsRoot, "s1", redact).writeSessionJson(sessionJson("s1", { turns: 1 }));
		const broken = SessionDir.create(sessionsRoot, "s2", redact);

		const db = openDb(":memory:");
		upsertSessionRow(db, sessionRowFromJson(sessionJson("stale"), "/gone"));
		const result = reindex(db, runsRoot, sessionsRoot);
		expect(result).toMatchObject({ runs: 1, sessions: 1, skipped: [broken.root] });
		expect(getRun(db, "r1")).toMatchObject({ sessionId: "s1", turnIndex: 1 });
		expect(listSessionRows(db).map((s) => s.id)).toEqual(["s1"]);
		expect(getSessionRow(db, "s1")?.dirPath).toBe(join(sessionsRoot, "s1"));
	});
});
