import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { costReport, insertRun, insertSpan, listFeedback, openDb, queryRuns, resolveNexoPaths } from "@nexo/store";
import { runRow, spanRow } from "../../store/test/fixtures.ts";
import { abortOnSignals, type CliIO, runCli } from "../src/main.ts";

function io(): CliIO & { out: () => string; err: () => string } {
	let out = "";
	let err = "";
	return {
		stdout: { write: (s: string) => ((out += s), true) },
		stderr: { write: (s: string) => ((err += s), true) },
		out: () => out,
		err: () => err,
	};
}

const homes: string[] = [];
afterEach(() => {
	for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(config?: unknown): { env: NodeJS.ProcessEnv; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "nexo-cli-"));
	homes.push(root);
	mkdirSync(join(root, "home"), { recursive: true });
	if (config) writeFileSync(join(root, "home", "config.json"), JSON.stringify(config));
	return { env: { NEXO_HOME: join(root, "home") }, cwd: root };
}

const config = {
	models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "fast" } },
	providers: { faux: { retryBaseDelayMs: 0, rateLimitBaseDelayMs: 0 } },
};

function fauxModels(responses: ReturnType<typeof fauxAssistantMessage>[]) {
	const faux = fauxProvider({ models: [{ id: "fast", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

describe("nexo run", () => {
	it("streams output, prints a summary and exits 0", async () => {
		const h = home(config);
		const t = io();
		const code = await runCli(["run", "Say", "hello"], t, { ...h, models: fauxModels([fauxAssistantMessage("hello there")]) });
		expect(code).toBe(0);
		expect(t.out()).toContain("hello there");
		expect(t.err()).toMatch(/succeeded · \$\d+\.\d{4} · trajectory \w+/);
	});

	it("prints an auto-allowed line on stderr when the approver allows a tool", async () => {
		const h = home({ ...config, tools: { policy: { bash: "ask" }, autoApprove: "on" } });
		const t = io();
		const responses = [
			fauxAssistantMessage([fauxToolCall("bash", { command: "touch hi" })]),
			fauxAssistantMessage('{"decision":"allow","reason":"prints text"}'),
			fauxAssistantMessage("done"),
		];
		const code = await runCli(["run", "say", "hi"], t, { ...h, models: fauxModels(responses) });
		expect(code).toBe(0);
		expect(t.err()).toContain("auto-allowed: prints text");
	});

	it("exits 2 with the error and hint when config is missing", async () => {
		const h = home();
		const t = io();
		const code = await runCli(["run", "x"], t, { ...h, models: fauxModels([]) });
		expect(code).toBe(2);
		expect(t.err()).toContain("error [CONFIG_INVALID]");
		expect(t.err()).toContain("/models is required");
		expect(t.err()).toMatch(/hint: .*\/models\/s1.*\/models\/s2/);
	});

	it("rejects a non-finite --budget with exit 2", async () => {
		const h = home(config);
		expect(await runCli(["run", "--budget", "Infinity", "x"], io(), { ...h, models: fauxModels([]) })).toBe(2);
	});

	it("rejects invalid --effort and a missing instruction with exit 2", async () => {
		const h = home(config);
		expect(await runCli(["run", "--effort", "extreme", "x"], io(), { ...h, models: fauxModels([]) })).toBe(2);
		expect(await runCli(["run"], io(), { ...h, models: fauxModels([]) })).toBe(2);
	});

	it("exits 130 and writes run.json when aborted", async () => {
		const h = home(config);
		const ac = new AbortController();
		const models = fauxModels([]);
		const faux = fauxProvider({ models: [{ id: "fast" }] });
		faux.setResponses([
			async () => {
				ac.abort();
				await new Promise((r) => setTimeout(r, 30));
				return fauxAssistantMessage("late");
			},
		]);
		models.setProvider(faux.provider);
		const t = io();
		const code = await runCli(["run", "slow"], t, { ...h, models, signal: ac.signal });
		expect(code).toBe(130);
		expect(t.err()).toContain("aborted");
		const runDir = /· (\S+)\n/.exec(t.err())?.[1];
		expect(runDir && existsSync(join(runDir, "run.json"))).toBe(true);
		expect(JSON.parse(readFileSync(join(runDir as string, "run.json"), "utf8")).status).toBe("aborted");
	});
});

describe("post-run review", () => {
	it("records the verdict typed after a run", async () => {
		const h = home(config);
		const answers = ["n", "wrong greeting"];
		const asked: string[] = [];
		const reviewAsker = { ask: async (q: string) => (asked.push(q), answers.shift() ?? null) };
		const code = await runCli(["run", "Say", "hello"], io(), { ...h, models: fauxModels([fauxAssistantMessage("hi")]), reviewAsker });
		expect(code).toBe(0);
		expect(asked[0]).toContain("[d]one / [n]ot done / [s]kip");
		const db = openDb(resolveNexoPaths(h.env).db);
		const [run] = queryRuns(db).runs;
		expect(run?.verdict).toBe("not_done");
		expect(listFeedback(db, run?.id ?? "")[0]?.comment).toBe("wrong greeting");
	});

	it("does not open the prompt when a signal arrives after the run finished", async () => {
		const h = home(config);
		const ac = new AbortController();
		const t = io();
		const spy = { ask: vi.fn(async () => "d") };
		const watched = { ...t, stderr: { write: (s: string) => (s.startsWith("✓") && ac.abort(), t.stderr.write(s)) } };
		const code = await runCli(["run", "x"], watched, { ...h, models: fauxModels([fauxAssistantMessage("ok")]), reviewAsker: spy, signal: ac.signal });
		expect(code).toBe(130);
		expect(spy.ask).not.toHaveBeenCalled();
	});

	it("ends the prompt and returns the signal code when a signal arrives while it waits", async () => {
		const h = home(config);
		const ac = new AbortController();
		const reviewAsker = {
			ask: (_q: string, signal?: AbortSignal) =>
				new Promise<string | null>((resolve) => {
					signal?.addEventListener("abort", () => resolve(null), { once: true });
					setTimeout(() => ac.abort(), 5);
				}),
		};
		const code = await runCli(["run", "x"], io(), { ...h, models: fauxModels([fauxAssistantMessage("ok")]), reviewAsker, signal: ac.signal });
		expect(code).toBe(130);
		expect(queryRuns(openDb(resolveNexoPaths(h.env).db), { reviewed: false }).runs).toHaveLength(1);
	});

	it("never asks with --no-review or without a terminal, so the run waits in the review queue", async () => {
		const h = home(config);
		const reviewAsker = { ask: vi.fn(async () => "d") };
		await runCli(["run", "--no-review", "x"], io(), { ...h, models: fauxModels([fauxAssistantMessage("ok")]), reviewAsker });
		await runCli(["run", "y"], io(), { ...h, models: fauxModels([fauxAssistantMessage("ok")]), reviewAsker: null });
		expect(reviewAsker.ask).not.toHaveBeenCalled();
		expect(queryRuns(openDb(resolveNexoPaths(h.env).db), { reviewed: false }).runs).toHaveLength(2);
	});
});

describe("post-run review store failure", () => {
	it("reports a failed run.json mirror write without changing the run's exit code", async () => {
		const h = home(config);
		const t = io();
		let runDir = "";
		const reviewAsker = {
			ask: async () => {
				runDir = join(resolveNexoPaths(h.env).runs, queryRuns(openDb(resolveNexoPaths(h.env).db)).runs[0]?.id ?? "");
				chmodSync(runDir, 0o500);
				return "d";
			},
		};
		try {
			const code = await runCli(["run", "x"], t, { ...h, models: fauxModels([fauxAssistantMessage("ok")]), reviewAsker });
			expect(code).toBe(0);
			expect(t.err()).toContain("error [STORE_IO]");
		} finally {
			if (runDir) chmodSync(runDir, 0o700);
		}
	});
});

describe("nexo ui", () => {
	async function startUi(h: { env: NodeJS.ProcessEnv; cwd: string }, t: ReturnType<typeof io>) {
		const ac = new AbortController();
		const running = runCli(["ui", "--port", "0"], t, { ...h, signal: ac.signal });
		for (let i = 0; i < 100 && !t.out().includes("token="); i++) await new Promise((r) => setTimeout(r, 10));
		const url = /nexo UI: (\S+)/.exec(t.out())?.[1] ?? "";
		const token = new URL(url).searchParams.get("token") ?? "";
		const postVerdict = (runId: string) =>
			fetch(new URL(`/api/runs/${runId}/feedback`, url), {
				method: "POST",
				headers: { "content-type": "application/json", "x-nexo-token": token },
				body: JSON.stringify({ verdict: "done", comment: "looks right" }),
			});
		return { url, running, stop: () => ac.abort(), postVerdict };
	}

	it("prints a tokenized URL, serves the API read-only without a config and stops when the signal aborts", async () => {
		const h = home();
		const t = io();
		const ui = await startUi(h, t);
		expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]{32}$/);
		expect(t.err()).toContain("config is missing or invalid; the UI is read-only");
		const res = await fetch(new URL("/api/runs", ui.url));
		expect(await res.json()).toEqual({ runs: [], nextCursor: null, total: 0 });
		const meta = (await (await fetch(new URL("/api/meta", ui.url))).json()) as { readOnly: { message: string } | null };
		expect(meta.readOnly?.message).toBe("the nexo config is missing or invalid");
		const refused = await ui.postVerdict("01UNKNOWN0000000000000000");
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
		ui.stop();
		expect(await ui.running).toBe(0);
		expect(t.err()).toContain("nexo UI stopped");
		await expect(fetch(new URL("/api/runs", ui.url))).rejects.toThrow();
	});

	it("marks runs left by a crashed process as aborted at startup, so they can be reviewed", async () => {
		const h = home(config);
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		const db = openDb(resolveNexoPaths(h.env).db);
		const crashed = runRow({ status: "running", pid: deadPid, dirPath: join(h.cwd, "gone") });
		insertRun(db, crashed);
		db.close();
		const t = io();
		const ui = await startUi(h, t);
		expect(t.err()).toContain("Marked 1 run(s) left by a crashed process as aborted");
		const list = (await (await fetch(new URL("/api/runs?reviewed=false", ui.url))).json()) as { runs: { id: string; status: string }[] };
		expect(list.runs.map((r) => [r.id, r.status])).toEqual([[crashed.id, "aborted"]]);
		expect((await ui.postVerdict(crashed.id)).status).toBe(201);
		ui.stop();
		expect(await ui.running).toBe(0);
	});

	it("rejects an invalid --port and an invalid ui.port with exit 2", async () => {
		const t = io();
		expect(await runCli(["ui", "--port", "99999"], t, home())).toBe(2);
		expect(t.err()).toContain("--port must be an integer");
		expect(await runCli(["ui"], t, home({ ...config, ui: { port: 0 } }))).toBe(2);
		expect(t.err()).toContain("ui.port must be an integer from 1 to 65535");
	});
});

describe("nexo reindex and cost", () => {
	it("reindex prints counts", async () => {
		const h = home(config);
		await runCli(["run", "x"], io(), { ...h, models: fauxModels([fauxAssistantMessage("ok")]) });
		const t = io();
		expect(await runCli(["reindex"], t, { ...h, models: fauxModels([]) })).toBe(0);
		expect(t.out()).toMatch(/Reindexed 1 runs, \d+ spans/);
	});

	it("cost groups llm_call spend by the requested dimension", () => {
		const db = openDb(":memory:");
		const run = runRow({ skill: "report", status: "succeeded" });
		insertRun(db, run);
		const span = (model: string, tier: string, cost: number, unknown = false) =>
			insertSpan(
				db,
				spanRow(run.id, { name: model, model, tier, status: "ok", startedAt: "2026-10-10T01:00:00.000Z", costUsd: cost, costUnknown: unknown }),
			);
		span("fast", "s1", 0.1);
		span("fast", "s1", 0.2);
		span("slow", "s2", 0.5, true);
		expect(costReport(db, { by: "model", since: "2026-01-01" }).rows).toEqual([
			{ key: "faux/slow", costUsd: 0.5, calls: 1, unknownCalls: 1 },
			{ key: "faux/fast", costUsd: expect.closeTo(0.3), calls: 2, unknownCalls: 0 },
		]);
		expect(costReport(db, { by: "skill", since: "2026-01-01" }).rows[0]?.key).toBe("report");
		expect(costReport(db, { by: "day", since: "2026-01-01" }).rows[0]?.key).toBe("2026-10-10");
		expect(costReport(db, { by: "tier", since: "2027-01-01" }).rows).toEqual([]);
	});

	it("cost rejects an unknown --by and an impossible --since with exit 2", async () => {
		const t = io();
		expect(await runCli(["cost", "--by", "color"], t, home())).toBe(2);
		expect(t.err()).toContain('Unknown cost dimension "color"');
		expect(await runCli(["cost", "--since", "2026-02-30"], t, home())).toBe(2);
		expect(t.err()).toContain("since must be a date");
	});
});

describe("signal wiring", () => {
	function setup() {
		const source = new EventEmitter();
		const controller = new AbortController();
		const exit = vi.fn();
		const signals = abortOnSignals(source, controller, exit);
		return { source, controller, exit, signals };
	}

	it("aborts on the first SIGINT or SIGTERM and remembers which", () => {
		for (const name of ["SIGINT", "SIGTERM"] as const) {
			const { source, controller, exit, signals } = setup();
			source.emit(name);
			expect(controller.signal.aborted).toBe(true);
			expect(signals.received()).toBe(name);
			expect(exit).not.toHaveBeenCalled();
		}
	});

	it("exits on a second signal of either kind", () => {
		const a = setup();
		a.source.emit("SIGTERM");
		a.source.emit("SIGINT");
		expect(a.exit).toHaveBeenCalledWith(130);
		const b = setup();
		b.source.emit("SIGINT");
		b.source.emit("SIGINT");
		expect(b.exit).toHaveBeenCalledWith(130);
		const c = setup();
		c.source.emit("SIGINT");
		c.source.emit("SIGTERM");
		expect(c.exit).toHaveBeenCalledWith(143);
	});

	it("removes its listeners on dispose", () => {
		const { source, signals } = setup();
		signals.dispose();
		expect(source.listenerCount("SIGINT") + source.listenerCount("SIGTERM")).toBe(0);
	});
});
