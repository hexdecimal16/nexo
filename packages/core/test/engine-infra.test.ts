import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createRedactor, REDACTED } from "@nexo/telemetry";
import { insertRun, listSpans, openDb, RunDir } from "@nexo/store";
import { runRow } from "../../store/test/fixtures.ts";
import { classifyProviderError, providerRetryDelayMs, retryAfterMs } from "../src/engine/errors.ts";
import { assistantText, withBudgetLine } from "../src/engine/messages.ts";
import { createGatedStreamFn } from "../src/engine/provider-gate.ts";
import { Recorder } from "../src/engine/recorder.ts";
import { Semaphore } from "../src/engine/semaphore.ts";

describe("Semaphore", () => {
	it("limits concurrency, serves waiters FIFO, skips aborted waiters, and has idempotent releases", async () => {
		const sem = new Semaphore(1);
		const order: string[] = [];
		const r1 = await sem.acquire();
		const ac = new AbortController();
		const waiter = (name: string, signal?: AbortSignal) =>
			sem.acquire(signal).then((release) => {
				order.push(name);
				return release;
			});
		const p2 = waiter("2");
		const p3 = waiter("3", ac.signal);
		const p4 = waiter("4");
		const p5 = waiter("5");
		ac.abort();
		await expect(p3).rejects.toMatchObject({ name: "AbortError" });
		r1();
		r1();
		const r2 = await p2;
		expect(order).toEqual(["2"]);
		r2();
		const r4 = await p4;
		expect(order).toEqual(["2", "4"]);
		r4();
		(await p5)();
		expect(order).toEqual(["2", "4", "5"]);
	});
});

describe("Recorder", () => {
	it("writes spans to SQLite and trajectory.jsonl, merging attrs on finish", () => {
		const db = openDb(":memory:");
		const root = mkdtempSync(join(tmpdir(), "nexo-runs-"));
		const redact = createRedactor();
		const runDir = RunDir.create(root, "r1", redact);
		insertRun(db, runRow({ id: "r1", dirPath: runDir.root }));
		let t = 0;
		const rec = new Recorder({ db, runDir, runId: "r1", now: () => new Date(Date.UTC(2026, 9, 10, 0, 0, t++)), redact });
		const id = rec.start({ kind: "tool_call", name: "bash", parentSpanId: null, attrs: { args: { command: "ls" } } });
		rec.finish(id, { status: "ok", attrs: { durationMs: 5 } });
		const [span] = listSpans(db, "r1");
		expect(span).toMatchObject({ id, status: "ok", attrs: { args: { command: "ls" }, durationMs: 5 } });
		expect(span?.endedAt).not.toBeNull();
		const lines = readFileSync(join(runDir.root, "trajectory.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	it("redacts span payloads before writing them to SQLite", () => {
		const db = openDb(":memory:");
		const redact = createRedactor();
		const runDir = RunDir.create(mkdtempSync(join(tmpdir(), "nexo-runs-")), "r2", redact);
		insertRun(db, runRow({ id: "r2", dirPath: runDir.root }));
		const rec = new Recorder({ db, runDir, runId: "r2", now: () => new Date(), redact });
		const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
		const id = rec.start({ kind: "llm_call", name: "m", parentSpanId: null, attrs: { prompt: `key ${secret}` } });
		rec.finish(id, { status: "error", attrs: { errorMessage: `bad key ${secret}` } });
		const [span] = listSpans(db, "r2");
		expect(span?.attrs).toEqual({ prompt: `key ${REDACTED}`, errorMessage: `bad key ${REDACTED}` });
	});
});

describe("createGatedStreamFn", () => {
	it("enforces per-provider maxConcurrent across requests", async () => {
		let active = 0;
		let maxActive = 0;
		const fakeModels = {
			streamSimple: () => {
				active++;
				maxActive = Math.max(maxActive, active);
				const done = new Promise((r) => setTimeout(r, 30)).then(() => {
					active--;
				});
				return { result: () => done } as unknown;
			},
		} as unknown as Models;
		const streamFn = createGatedStreamFn(fakeModels, { p: 1 });
		const model = { provider: "p" } as never;
		const streams = await Promise.all([1, 2, 3].map(() => streamFn(model, { messages: [] } as never)));
		await Promise.all(streams.map((s) => s.result()));
		expect(maxActive).toBe(1);
	});
});

describe("createGatedStreamFn permit handling", () => {
	const model = { provider: "p" } as never;
	const ctx = { messages: [] } as never;
	const modelsOf = (streamSimple: () => unknown) => ({ streamSimple }) as unknown as Models;

	it("releases the permit when result() rejects or resolves with an error message", async () => {
		const results = [() => Promise.reject(new Error("boom")), () => Promise.resolve({ stopReason: "error", errorMessage: "x" }), () => Promise.resolve({})];
		let i = 0;
		const streamFn = createGatedStreamFn(modelsOf(() => ({ result: results[i++ % results.length] })), { p: 1 });
		for (let n = 0; n < 3; n++) {
			const s = await streamFn(model, ctx);
			await s.result().catch(() => undefined);
		}
		expect(i).toBe(3);
	});

	it("releases the permit when streamSimple throws synchronously", async () => {
		let calls = 0;
		const streamFn = createGatedStreamFn(
			modelsOf(() => {
				calls++;
				if (calls === 1) throw new Error("no api key");
				return { result: () => Promise.resolve({}) };
			}),
			{ p: 1 },
		);
		await expect(streamFn(model, ctx)).rejects.toThrow("no api key");
		await streamFn(model, ctx);
		expect(calls).toBe(2);
	});

	it("rejects a waiting request on abort without consuming a permit", async () => {
		let resolveFirst: () => void = () => {};
		let calls = 0;
		const streamFn = createGatedStreamFn(
			modelsOf(() => {
				calls++;
				return { result: () => new Promise<void>((r) => (resolveFirst = r)) };
			}),
			{ p: 1 },
		);
		await streamFn(model, ctx);
		const ac = new AbortController();
		const waiting = streamFn(model, ctx, { signal: ac.signal } as never);
		ac.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(1);
		resolveFirst();
		await new Promise((r) => setTimeout(r, 0));
		await streamFn(model, ctx);
		expect(calls).toBe(2);
	});

	it("does not gate providers without a limit", async () => {
		let active = 0;
		let maxActive = 0;
		const streamFn = createGatedStreamFn(
			modelsOf(() => {
				active++;
				maxActive = Math.max(maxActive, active);
				return { result: () => new Promise((r) => setTimeout(r, 20)).then(() => void active--) };
			}),
			{ other: 1 },
		);
		const streams = await Promise.all([1, 2, 3].map(() => streamFn(model, ctx)));
		await Promise.all(streams.map((s) => s.result()));
		expect(maxActive).toBe(3);
	});
});

describe("messages helpers", () => {
	it("appends the budget line to the last user or tool-result message only", () => {
		const user: AgentMessage = { role: "user", content: "hi", timestamp: 1 };
		const out = withBudgetLine([user], "Budget: $1");
		expect(out[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "\n[nexo] Budget: $1" }], timestamp: 1 });
		expect(user.content).toBe("hi");
		const assistant = { role: "assistant", content: [] } as unknown as AgentMessage;
		expect(withBudgetLine([assistant], "x")).toEqual([assistant]);
	});

	it("extracts assistant text", () => {
		const msg = { role: "assistant", content: [{ type: "text", text: "a" }, { type: "toolCall", id: "1", name: "x", arguments: {} }, { type: "text", text: "b" }] } as unknown as AssistantMessage;
		expect(assistantText(msg)).toBe("ab");
	});
});

describe("provider error classification", () => {
	it.each([
		["401 Unauthorized: invalid x-api-key", "PROVIDER_AUTH"],
		["No API key found for anthropic", "PROVIDER_AUTH"],
		["429 Too Many Requests", "PROVIDER_RATE_LIMIT"],
		["Request timed out", "PROVIDER_TIMEOUT"],
		["503 Service Unavailable", "PROVIDER_UNAVAILABLE"],
	])("%s → %s", (message, code) => {
		expect(classifyProviderError(message).code).toBe(code);
	});

	it("marks a provider 400 as a non-retryable invalid request", () => {
		const gemini = `{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"Function call is missing a thought_signature\\",\\n    \\"status\\": \\"INVALID_ARGUMENT\\"\\n  }\\n}\\n","code":400,"status":"Bad Request"}}`;
		for (const message of [gemini, "400 Bad Request: messages.1.content is empty", "invalid_request_error: bad tool schema"]) {
			const error = classifyProviderError(message);
			expect(error.code, message).toBe("PROVIDER_UNAVAILABLE");
			expect(error.retryable, message).toBe(false);
			expect(error.hint, message).toContain("rejected the request as invalid");
		}
		expect(classifyProviderError("503 Service Unavailable").retryable).toBe(true);
		expect(classifyProviderError("Request failed after 4000ms").retryable).toBe(true);
	});

	it("treats Vertex RESOURCE_EXHAUSTED as a rate limit", () => {
		const vertex = `{"error":{"message":"{\\n  \\"error\\": {\\n \\"code\\": 429,\\n \\"message\\": \\"Resource exhausted. Please try again later.\\",\\n \\"status\\": \\"RESOURCE_EXHAUSTED\\"\\n }\\n}\\n","code":429,"status":"Too Many Requests"}}`;
		expect(classifyProviderError(vertex)).toMatchObject({ code: "PROVIDER_RATE_LIMIT", retryable: true });
		expect(classifyProviderError("RESOURCE_EXHAUSTED: quota")).toMatchObject({ code: "PROVIDER_RATE_LIMIT" });
	});

	it("waits seconds, doubling to a one-minute cap, between rate-limit retries", () => {
		const mid = () => 0.5;
		const delays = [1, 2, 3, 4, 5, 6].map((attempt) => providerRetryDelayMs(attempt, "429 Too Many Requests", {}, mid));
		expect(delays).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000]);
		expect(providerRetryDelayMs(1, "429", {}, () => 0)).toBe(4000);
		expect(providerRetryDelayMs(1, "429", {}, () => 0.999_999)).toBeCloseTo(6000, -1);
		expect(providerRetryDelayMs(2, "429", { rateLimitBaseDelayMs: 1000 }, mid)).toBe(2000);
		expect(providerRetryDelayMs(3, "429", { rateLimitBaseDelayMs: 0 }, mid)).toBe(0);
		expect(providerRetryDelayMs(1, "rate limited, retry-after: 90", {}, mid)).toBe(90_000);
	});

	it("keeps the short full-jitter backoff for other retryable errors", () => {
		expect(providerRetryDelayMs(1, "503 Service Unavailable", {}, () => 0.5)).toBe(500);
		expect(providerRetryDelayMs(3, "503 Service Unavailable", { retryBaseDelayMs: 100 }, () => 0.5)).toBe(200);
		expect(providerRetryDelayMs(1, "503, retry-after: 3", {}, () => 0)).toBe(3000);
	});

	it("parses retry-after hints", () => {
		expect(retryAfterMs("rate limited, retry-after: 7")).toBe(7000);
		expect(retryAfterMs("no hint")).toBeUndefined();
	});
});
