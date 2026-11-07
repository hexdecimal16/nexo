import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseStep, fauxToolCall, getSystemMessageText } from "@earendil-works/pi-ai";
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

function setup(responses: FauxResponseStep[]) {
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

describe("web search", () => {
	const BRAVE_KEY = "brave-sdk-key-0123456789";
	const braveFetch = (calls: string[] = []) =>
		(async (input: string | URL | Request) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ web: { results: [{ title: "Node 22", url: "https://nodejs.org/en/blog/node-22", description: "Node.js <b>22</b> released" }] } }), {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

	it("gives an unattended run the web_search tool, allowed without a prompt, when a key is passed in code", async () => {
		let systemPrompt = "";
		const h = setup([
			(context) => {
				systemPrompt = context.messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n");
				return fauxAssistantMessage([fauxToolCall("web_search", { query: "node 22" })]);
			},
			fauxAssistantMessage("found it"),
		]);
		const calls: string[] = [];
		const nexo = createNexo({ home: h.home, cwd: h.root, env: h.env, models: h.models, apiKeys: { brave: BRAVE_KEY }, fetch: braveFetch(calls) });
		const events: EngineEvent[] = [];
		try {
			const result = await nexo.run({ instruction: "When was node 22 released?", budgetUsd: 0.5 }, { onEvent: (e) => events.push(e) });
			expect(result.status).toBe("succeeded");
			const end = events.find((e) => e.type === "tool_end" && e.toolName === "web_search");
			expect(end).toMatchObject({ isError: false });
			expect(end && "output" in end ? end.output : "").toContain("1. [Node 22](https://nodejs.org/en/blog/node-22)");
			expect(calls).toHaveLength(1);
			// The prompt tells the agent when to search.
			expect(systemPrompt).toContain("use web_search for anything that may have changed");
		} finally {
			await nexo.close();
		}
	});

	it("leaves web_search out of a run without a search key", async () => {
		let systemPrompt = "";
		const h = setup([
			(context) => {
				systemPrompt = context.messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n");
				return fauxAssistantMessage([fauxToolCall("web_search", { query: "x" })]);
			},
			fauxAssistantMessage("done"),
		]);
		const nexo = createNexo({ home: h.home, cwd: h.root, env: h.env, models: h.models, fetch: braveFetch() });
		const events: EngineEvent[] = [];
		try {
			await nexo.run({ instruction: "search", budgetUsd: 0.5 }, { onEvent: (e) => events.push(e) });
			const end = events.find((e) => e.type === "tool_end" && e.toolName === "web_search");
			expect(end).toMatchObject({ isError: true });
			expect(systemPrompt).not.toContain("web_search");
		} finally {
			await nexo.close();
		}
	});

	it("searches directly, reports key status and stores keys", async () => {
		const h = setup([]);
		const nexo = createNexo({ home: h.home, cwd: h.root, env: h.env, models: h.models, fetch: braveFetch() });
		try {
			await expect(nexo.webSearch("node")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
			expect(nexo.keys().filter((k) => k.purpose === "search").map((k) => `${k.provider}:${k.state}`)).toEqual(["brave:unset", "tavily:unset"]);
			expect(nexo.setKey("brave", BRAVE_KEY)).toMatchObject({ state: "file", last4: "6789" });
			const outcome = await nexo.webSearch("node", { count: 3 });
			expect(outcome.answered).toEqual(["brave"]);
			expect(outcome.results[0]).toMatchObject({ title: "Node 22", snippet: "Node.js 22 released", providers: ["brave"] });
			expect(JSON.stringify(nexo.keys())).not.toContain(BRAVE_KEY);
			expect(nexo.removeKey("brave")).toMatchObject({ state: "unset" });
		} finally {
			await nexo.close();
		}
	});
});
