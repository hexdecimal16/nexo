import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addMemory, getActiveArtifact, listLearnJobs, listMemories, openDb, resolveNexoPaths } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { type CliIO, runCli } from "../src/main.ts";

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

const config = {
	models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "fast" } },
	providers: { faux: { retryBaseDelayMs: 0, maxRetries: 0 } },
};

function home(extra: object = {}): { env: NodeJS.ProcessEnv; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "nexo-cli-learn-"));
	homes.push(root);
	mkdirSync(join(root, "home"), { recursive: true });
	writeFileSync(join(root, "home", "config.json"), JSON.stringify({ ...config, ...extra }));
	return { env: { NEXO_HOME: join(root, "home") }, cwd: root };
}

function fauxModels(replies: string[]) {
	const faux = fauxProvider({ models: [{ id: "fast", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
	faux.setResponses(replies.map((r) => fauxAssistantMessage(r)));
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

const db = (h: { env: NodeJS.ProcessEnv }) => openDb(resolveNexoPaths(h.env).db);
const reflection = (content?: string) =>
	JSON.stringify({ lessons: content ? [{ content, type: "lesson", scope: "user", importance: 0.5, outcome: "success" }] : [], playbookTags: [] });

describe("nexo memory", () => {
	it("adds, lists and retires memories, including a human lesson", async () => {
		const h = home();
		const d = db(h);
		const human = addMemory(d, { scope: "user", type: "lesson", content: "Never deploy on Fridays", importance: 1, source: "human" }, createRedactor(), "2026-10-12T00:00:00.000Z");
		d.close();
		const t = io();
		expect(await runCli(["memory", "add", "Prod", "is", "eu-west-1", "--scope", "global", "--type", "fact"], t, h)).toBe(0);
		expect(t.out()).toMatch(/Added memory \w+ \(global, fact\)/);
		const list = io();
		expect(await runCli(["memory", "list"], list, h)).toBe(0);
		expect(list.out()).toContain("global           fact       user  0.80  Prod is eu-west-1");
		expect(list.out()).toContain("Never deploy on Fridays");
		expect(list.out()).toContain("2 memories");
		const retire = io();
		expect(await runCli(["memory", "retire", human.id], retire, h)).toBe(0);
		const after = io();
		await runCli(["memory", "list", "--all", "--scope", "user"], after, h);
		expect(after.out()).toContain("Never deploy on Fridays [retired]");
	});

	it("rejects bad input with structured errors", async () => {
		const h = home();
		const cases: [string[], string, number][] = [
			[["memory", "retire", "nope"], "NOT_FOUND", 1],
			[["memory", "add", "x", "--scope", "team"], "INVALID_REQUEST", 1],
			[["memory", "add", "x", "--type", "rule"], "CONFIG_INVALID", 2],
			[["memory", "add"], "CONFIG_INVALID", 2],
			[["memory"], "CONFIG_INVALID", 2],
			[["playbook", "show", "Bad Name"], "CONFIG_INVALID", 2],
			[["playbook", "retire", "ci", "k404"], "NOT_FOUND", 1],
		];
		for (const [argv, code, exit] of cases) {
			const t = io();
			expect(await runCli(argv, t, h), argv.join(" ")).toBe(exit);
			expect(t.err(), argv.join(" ")).toContain(`error [${code}]`);
		}
	});
});

describe("nexo playbook", () => {
	it("adds a human item, shows it and retires it, publishing manual versions", async () => {
		const h = home();
		const t = io();
		expect(await runCli(["playbook", "add", "ci", "Ask", "before", "force-pushing"], t, h)).toBe(0);
		expect(t.out()).toContain("Added ci/k001 · playbook version 1");
		const show = io();
		await runCli(["playbook", "show", "ci"], show, h);
		expect(show.out()).toContain("Playbook ci · version 1 (manual)");
		expect(show.out()).toContain("[k001] human +0/-0  Ask before force-pushing");
		const retire = io();
		expect(await runCli(["playbook", "retire", "ci", "k001"], retire, h)).toBe(0);
		expect(retire.out()).toContain("Retired ci/k001 · playbook version 2");
		const d = db(h);
		expect(getActiveArtifact(d, "playbook", "ci")).toMatchObject({ version: 2, content: "" });
		d.close();
	});
});

describe("nexo learn", () => {
	it("learns after nexo run within the drain window and keeps the exit code", async () => {
		const h = home();
		const t = io();
		const code = await runCli(["run", "Say", "hi", "--no-review"], t, { ...h, models: fauxModels(["hi", reflection("Greet briefly"), JSON.stringify({ memory: [{ op: "add", type: "preference", scope: "user", content: "Greet briefly", importance: 0.5 }], playbook: [] })]) });
		expect(code).toBe(0);
		expect(t.err()).toMatch(/learn ✓ run \w+: 1 lesson, \+1 memory/);
		const d = db(h);
		expect(listMemories(d).map((m) => m.content)).toEqual(["Greet briefly"]);
		d.close();
	});

	it("keeps exit code 0 when learning after the run fails", async () => {
		const h = home();
		const t = io();
		expect(await runCli(["run", "Say", "hi", "--no-review"], t, { ...h, models: fauxModels(["hi", "prose", "more prose"]) })).toBe(0);
		expect(t.err()).toMatch(/learn ✗ run \w+: \[SCORER_FAILED\]/);
	});

	it("drains pending jobs, exits 1 when one fails, and --retry runs failed ones again", async () => {
		const h = home({ learning: { drainAfterRunMs: 0 } });
		await runCli(["run", "Say", "hi", "--no-review"], io(), { ...h, models: fauxModels(["hi"]) });
		const first = io();
		expect(await runCli(["learn"], first, { ...h, models: fauxModels(["prose", "prose"]) })).toBe(1);
		expect(first.out()).toContain("0 succeeded, 1 failed · 0 pending, 1 failed in total");
		const again = io();
		expect(await runCli(["learn", "--retry"], again, { ...h, models: fauxModels([reflection()]) })).toBe(0);
		expect(again.out()).toContain("Retrying 1 failed job");
		expect(again.out()).toMatch(/✓ run \w+: 0 lessons/);
		const d = db(h);
		expect(listLearnJobs(d).map((j) => [j.status, j.attempts])).toEqual([["succeeded", 2]]);
		d.close();
	});

	it("nexo ui runs pending learn jobs in the background", async () => {
		const h = home({ learning: { drainAfterRunMs: 0 } });
		await runCli(["run", "Say", "hi", "--no-review"], io(), { ...h, models: fauxModels(["hi"]) });
		const ac = new AbortController();
		const running = runCli(["ui", "--port", "0"], io(), { ...h, signal: ac.signal, models: fauxModels([reflection()]) });
		await vi.waitFor(
			() => {
				const d = db(h);
				try {
					expect(listLearnJobs(d)[0]?.status).toBe("succeeded");
				} finally {
					d.close();
				}
			},
			{ timeout: 5000, interval: 50 },
		);
		ac.abort();
		expect(await running).toBe(0);
	});

	it("says so and runs nothing when learning is off", async () => {
		const h = home({ learning: { enabled: false } });
		const t = io();
		expect(await runCli(["learn"], t, { ...h, models: fauxModels([]) })).toBe(0);
		expect(t.out()).toContain("Learning is off");
	});
});
