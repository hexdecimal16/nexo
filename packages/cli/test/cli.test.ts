import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { costReport, insertRun, insertSpan, openDb } from "@nexo/store";
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

function home(config?: unknown): { env: NodeJS.ProcessEnv; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "nexo-cli-"));
	mkdirSync(join(root, "home"), { recursive: true });
	if (config) writeFileSync(join(root, "home", "config.json"), JSON.stringify(config));
	return { env: { NEXO_HOME: join(root, "home") }, cwd: root };
}

const config = {
	models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "fast" } },
	providers: { faux: { retryBaseDelayMs: 0 } },
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
