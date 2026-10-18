import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { checkSetup, createNexo, type EngineEvent } from "../src/index.ts";

const config = {
	models: { s1: { provider: "faux", id: "fast" }, s2: { provider: "faux", id: "fast" } },
	providers: { faux: { retryBaseDelayMs: 0, rateLimitBaseDelayMs: 0 } },
};

const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(responses: ReturnType<typeof fauxAssistantMessage>[]) {
	const root = mkdtempSync(join(tmpdir(), "nexo-sdk-"));
	roots.push(root);
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "config.json"), JSON.stringify(config));
	const faux = fauxProvider({ models: [{ id: "fast", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	return { root, home, models, env: { PATH: process.env.PATH } as NodeJS.ProcessEnv };
}

describe("createNexo", () => {
	it("runs an instruction and delivers events to the run listener", async () => {
		const h = setup([fauxAssistantMessage("hello from the sdk")]);
		const nexo = createNexo({ home: h.home, cwd: h.root, env: h.env, models: h.models });
		const events: EngineEvent[] = [];
		try {
			const result = await nexo.run({ instruction: "Say hello", budgetUsd: 0.5 }, { onEvent: (e) => events.push(e) });
			expect(result.status).toBe("succeeded");
			expect(result.output).toContain("hello from the sdk");
			expect(events.length).toBeGreaterThan(0);
		} finally {
			await nexo.close();
		}
	});

	it("runs a session turn", async () => {
		const h = setup([fauxAssistantMessage("turn one")]);
		const nexo = createNexo({ home: h.home, cwd: h.root, env: h.env, models: h.models });
		try {
			const session = nexo.createSession({ cwd: h.root });
			const result = await session.turn("Hi");
			expect(result.output).toContain("turn one");
			expect(session.turns).toBe(1);
			session.close();
		} finally {
			await nexo.close();
		}
	});

	it("rejects use after close and allows closing twice", async () => {
		const h = setup([]);
		const nexo = createNexo({ home: h.home, cwd: h.root, env: h.env, models: h.models });
		await nexo.close();
		await nexo.close();
		await expect(nexo.run({ instruction: "x" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});

	it("checkSetup reports a healthy setup and a missing one", () => {
		const h = setup([]);
		expect(checkSetup({ home: h.home, cwd: h.root, env: h.env, models: h.models }).ok).toBe(true);
		const empty = mkdtempSync(join(tmpdir(), "nexo-sdk-empty-"));
		roots.push(empty);
		mkdirSync(join(empty, "home"));
		expect(checkSetup({ home: join(empty, "home"), cwd: empty, env: h.env, models: h.models }).ok).toBe(false);
	});
});
