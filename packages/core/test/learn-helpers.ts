import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { enqueueLearnJob, type LearnJobRow, listLearnJobs } from "@nexo/store";
import { createEngine, createEngineEnv, type EngineEnv, type RunResult } from "../src/index.ts";
import { makeEnv as baseMakeEnv, type TestEnv } from "./helpers.ts";

/** A reflection reply with these lessons and tags. */
export function reflection(lessons: object[] = [], playbookTags: object[] = []): string {
	return JSON.stringify({ lessons, playbookTags });
}

export function lesson(content: string, overrides: object = {}): object {
	return { content, type: "lesson", scope: "user", importance: 0.6, outcome: "failure", ...overrides };
}

export function delta(memory: object[] = [], playbook: object[] = []): string {
	return JSON.stringify({ memory, playbook });
}

/** Replies in order: each string is one model call (agent turns, then reflector and curator calls). */
export function script(env: TestEnv, replies: (string | FauxResponseFactory)[]): { calls: () => number; prompts: string[] } {
	let n = 0;
	const prompts: string[] = [];
	const factory: FauxResponseFactory = async (context, opts, state, model) => {
		const msg = context.messages.find((m) => m.role === "user");
		prompts.push(typeof msg?.content === "string" ? msg.content : (msg?.content ?? []).map((b) => ("text" in b ? b.text : "")).join(""));
		const step = replies[n++];
		if (step === undefined) throw new Error(`script exhausted at call ${n}`);
		return typeof step === "function" ? step(context, opts, state, model) : fauxAssistantMessage(step);
	};
	env.faux.setResponses(Array.from({ length: 60 }, () => factory));
	return { calls: () => n, prompts };
}

/** Runs one engine run whose agent replies `answer`; returns the result and the env learn jobs run in. */
export async function finishedRun(env: TestEnv, request: { instruction: string; skill?: string } = { instruction: "Fix the build" }): Promise<{ result: RunResult; learnEnv: EngineEnv }> {
	const result = await createEngine(env.deps).run(request);
	return { result, learnEnv: createEngineEnv(env.deps) };
}

/** `makeEnv` with learning on unless the test turns it off. */
export function makeEnv(options: Parameters<typeof baseMakeEnv>[0] = {}): TestEnv {
	return baseMakeEnv({ ...options, config: { ...options.config, learning: { enabled: true, ...options.config?.learning } } });
}

/** The run's pending reflect job: a new one, or the one already pending (runs enqueue their own when they finish). */
export function queueJob(env: TestEnv, runId: string, trigger: "run_end" | "feedback" = "run_end"): LearnJobRow {
	const job = enqueueLearnJob(env.deps.db, { runId, trigger }, new Date().toISOString()) ?? listLearnJobs(env.deps.db, { runId, status: "pending" })[0];
	if (!job) throw new Error(`no pending job for ${runId}`);
	return job;
}

export interface EmbeddingServer {
	baseUrl: string;
	requests: { headers: IncomingMessage["headers"]; body: { model: string; input: string[]; dimensions?: number } }[];
	close(): Promise<void>;
}

/**
 * A local OpenAI-compatible /embeddings endpoint on 127.0.0.1. `reply` maps the request inputs to the HTTP status and
 * JSON body; the default embeds each text as [1, 0] when it contains "alpha", else [0, 1], and reports 3 tokens per text.
 */
export async function embeddingServer(reply?: (input: string[]) => { status: number; body: unknown } | null): Promise<EmbeddingServer> {
	const requests: EmbeddingServer["requests"] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as EmbeddingServer["requests"][number]["body"];
			requests.push({ headers: req.headers, body });
			const custom = reply?.(body.input);
			if (custom === null) return;
			const out = custom ?? {
				status: 200,
				body: { data: body.input.map((t, index) => ({ index, embedding: t.includes("alpha") ? [1, 0] : [0, 1] })).reverse(), usage: { prompt_tokens: 3 * body.input.length } },
			};
			res.writeHead(out.status, { "content-type": "application/json" });
			res.end(JSON.stringify(out.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
