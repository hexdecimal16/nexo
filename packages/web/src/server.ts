import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Db } from "@nexo/store";
import { NexoError, type Redactor } from "@nexo/telemetry";
import type { ReadOnlyInfo } from "../public/lib/api-types.ts";
import {
	type ApiContext,
	costResponse,
	evalCasesResponse,
	reviewEvalCaseResponse,
	feedbackResponse,
	judgeCalibrationResponse,
	learnJobsResponse,
	listRunsResponse,
	memoriesResponse,
	memoryDetailResponse,
	metaResponse,
	approveOptimResponse,
	optimDetailResponse,
	optimListResponse,
	playbookResponse,
	playbooksResponse,
	retireMemoryResponse,
	retirePlaybookItemResponse,
	listSessionsResponse,
	runDetailResponse,
	serveRunFile,
	spanResponse,
	spanTreeResponse,
} from "./api.ts";
import { sendError, sendJson } from "./http-errors.ts";
import { createStaticServer } from "./static.ts";

export const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

/** Largest accepted request body (feedback JSON). */
export const MAX_BODY_BYTES = 64 * 1024;

export const TOKEN_HEADER = "x-nexo-token";

export interface WebServerOptions {
	db: Db;
	redact: Redactor;
	/** Always loopback; the server refuses to bind anywhere else. */
	host?: "127.0.0.1";
	/** 0 picks a free port. */
	port?: number;
	token?: string;
	publicDir?: string;
	now?: () => Date;
	/** Refuse every mutating route with CONFIG_INVALID (used when the nexo config, and so its redaction patterns, failed to load). */
	readOnly?: ReadOnlyInfo | null;
	/** The configured judge key (`models.judge` joined with `+`) and its same-family warnings, for the calibration view. */
	judge?: { key: string | null; warnings: string[] };
	/** `learning.enabled` of the loaded config (default off): verdicts then store human lessons and enqueue learn jobs. */
	learning?: { enabled: boolean };
	/** `optimize.minJudgeKappa` of the loaded config (default 0.6), for the approval gate. */
	optimize?: { minJudgeKappa: number };
}

export interface WebServer {
	readonly url: string;
	readonly port: number;
	readonly token: string;
	close(): Promise<void>;
}

const RUN_ID = "([0-9A-Za-z]{1,64})";
const ROUTES = {
	runs: /^\/api\/runs$/,
	run: new RegExp(`^/api/runs/${RUN_ID}$`),
	spans: new RegExp(`^/api/runs/${RUN_ID}/spans$`),
	span: new RegExp(`^/api/runs/${RUN_ID}/spans/${RUN_ID}$`),
	files: new RegExp(`^/api/runs/${RUN_ID}/files(?:/(.*))?$`),
	feedback: new RegExp(`^/api/runs/${RUN_ID}/feedback$`),
	sessions: /^\/api\/sessions$/,
	costs: /^\/api\/costs$/,
	calibration: /^\/api\/judge\/calibration$/,
	memories: /^\/api\/memories$/,
	memory: new RegExp(`^/api/memories/${RUN_ID}$`),
	memoryRetire: new RegExp(`^/api/memories/${RUN_ID}/retire$`),
	playbooks: /^\/api\/playbooks$/,
	playbook: /^\/api\/playbooks\/([^/]{1,64})$/,
	playbookRetire: /^\/api\/playbooks\/([^/]{1,64})\/items\/([^/]{1,64})\/retire$/,
	learnJobs: /^\/api\/learn\/jobs$/,
	optimList: /^\/api\/optim$/,
	optim: new RegExp(`^/api/optim/${RUN_ID}$`),
	optimApprove: new RegExp(`^/api/optim/${RUN_ID}/approve$`),
	evalCases: /^\/api\/eval-cases$/,
	evalCaseReview: new RegExp(`^/api/eval-cases/${RUN_ID}/(accept|dismiss)$`),
	meta: /^\/api\/meta$/,
};

function methodNotAllowed(method: string, path: string, allowed: string): NexoError {
	return new NexoError({ code: "METHOD_NOT_ALLOWED", message: `${method} is not supported on ${path}`, context: { method, path, allowed } });
}

function forbidden(message: string, hint?: string): NexoError {
	return new NexoError({ code: "FORBIDDEN", message, ...(hint ? { hint } : {}) });
}

function tokensMatch(given: string | undefined, expected: string): boolean {
	if (!given) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const type = req.headers["content-type"] ?? "";
	if (!type.startsWith("application/json")) {
		throw new NexoError({ code: "INVALID_REQUEST", message: "Content-Type must be application/json", context: { contentType: type } });
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) {
			throw new NexoError({ code: "INVALID_REQUEST", message: `Request body is larger than ${MAX_BODY_BYTES} bytes` });
		}
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new NexoError({ code: "INVALID_REQUEST", message: "Request body is not valid JSON" });
	}
}

function decodePath(path: string): string {
	try {
		return decodeURIComponent(path);
	} catch {
		throw new NexoError({ code: "INVALID_REQUEST", message: "Path is not valid percent-encoding", context: { path } });
	}
}

/**
 * Starts the UI server on 127.0.0.1. GET requests need no token; every other method needs the per-launch token in
 * the `x-nexo-token` header. Requests whose Host is not this loopback address are refused, which blocks DNS
 * rebinding from reading the token out of a served page.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
	const host = options.host ?? "127.0.0.1";
	if (host !== "127.0.0.1") throw new NexoError({ code: "CONFIG_INVALID", message: "The web UI binds to 127.0.0.1 only", context: { host } });
	const token = options.token ?? randomBytes(24).toString("base64url");
	const ctx: ApiContext = {
		db: options.db,
		redact: options.redact,
		now: options.now ?? (() => new Date()),
		readOnly: options.readOnly ?? null,
		judge: options.judge ?? { key: null, warnings: [] },
		learning: options.learning ?? { enabled: false },
		optimize: options.optimize ?? { minJudgeKappa: 0.6 },
	};
	const assertWritable = (): void => {
		if (!ctx.readOnly) return;
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: `The UI is read-only: ${ctx.readOnly.message}`,
			...(ctx.readOnly.hint ? { hint: ctx.readOnly.hint } : {}),
		});
	};
	const statics = createStaticServer(options.publicDir ?? DEFAULT_PUBLIC_DIR, token);
	let allowedHosts: Set<string> = new Set();

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const method = req.method ?? "GET";
		if (!allowedHosts.has(req.headers.host ?? "")) {
			throw forbidden(`Host "${req.headers.host ?? ""}" is not allowed`, "Open the URL printed by `nexo ui`");
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;
		const mutating = method !== "GET";
		if (mutating && !tokensMatch(req.headers[TOKEN_HEADER] as string | undefined, token)) {
			throw forbidden("Missing or wrong UI token", `The token is per \`nexo ui\` launch. If this page was opened before a restart, reload it from the URL the newest \`nexo ui\` printed; scripts send that URL's token in the ${TOKEN_HEADER} header`);
		}
		if (!path.startsWith("/api/")) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			statics.serve(res, path);
			return;
		}
		let m: RegExpExecArray | null;
		if (ROUTES.runs.test(path)) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, listRunsResponse(ctx, url.searchParams));
		}
		if (ROUTES.sessions.test(path)) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, listSessionsResponse(ctx, url.searchParams));
		}
		if ((m = ROUTES.run.exec(path))) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, runDetailResponse(ctx, m[1] as string));
		}
		if ((m = ROUTES.spans.exec(path))) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, spanTreeResponse(ctx, m[1] as string));
		}
		if ((m = ROUTES.span.exec(path))) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, spanResponse(ctx, m[1] as string, m[2] as string));
		}
		if ((m = ROUTES.files.exec(path))) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return serveRunFile(ctx, res, m[1] as string, decodePath(m[2] ?? ""), url.searchParams.get("full") === "1", req.headers.range);
		}
		if ((m = ROUTES.feedback.exec(path))) {
			if (method !== "POST") throw methodNotAllowed(method, path, "POST");
			assertWritable();
			const body = await readJsonBody(req);
			return sendJson(res, 201, feedbackResponse(ctx, m[1] as string, body));
		}
		if (ROUTES.meta.test(path)) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, metaResponse(ctx));
		}
		if (ROUTES.costs.test(path)) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, costResponse(ctx, url.searchParams));
		}
		if (ROUTES.calibration.test(path)) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, judgeCalibrationResponse(ctx));
		}
		if (ROUTES.memories.test(path)) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, memoriesResponse(ctx, url.searchParams));
		}
		if ((m = ROUTES.memory.exec(path))) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, memoryDetailResponse(ctx, m[1] as string));
		}
		if ((m = ROUTES.memoryRetire.exec(path))) {
			if (method !== "POST") throw methodNotAllowed(method, path, "POST");
			assertWritable();
			return sendJson(res, 200, retireMemoryResponse(ctx, m[1] as string));
		}
		if (ROUTES.playbooks.test(path)) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, playbooksResponse(ctx));
		}
		if ((m = ROUTES.playbook.exec(path))) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, playbookResponse(ctx, decodePath(m[1] as string), url.searchParams));
		}
		if ((m = ROUTES.playbookRetire.exec(path))) {
			if (method !== "POST") throw methodNotAllowed(method, path, "POST");
			assertWritable();
			return sendJson(res, 200, retirePlaybookItemResponse(ctx, decodePath(m[1] as string), decodePath(m[2] as string)));
		}
		if (ROUTES.learnJobs.test(path)) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, learnJobsResponse(ctx, url.searchParams));
		}
		if (ROUTES.optimList.test(path)) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, optimListResponse(ctx));
		}
		if ((m = ROUTES.optim.exec(path))) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, optimDetailResponse(ctx, m[1] as string));
		}
		if ((m = ROUTES.optimApprove.exec(path))) {
			if (method !== "POST") throw methodNotAllowed(method, path, "POST");
			assertWritable();
			return sendJson(res, 200, approveOptimResponse(ctx, m[1] as string));
		}
		if (ROUTES.evalCases.test(path)) {
			if (method !== "GET") throw methodNotAllowed(method, path, "GET");
			return sendJson(res, 200, evalCasesResponse(ctx, url.searchParams));
		}
		if ((m = ROUTES.evalCaseReview.exec(path))) {
			if (method !== "POST") throw methodNotAllowed(method, path, "POST");
			assertWritable();
			return sendJson(res, 200, reviewEvalCaseResponse(ctx, m[1] as string, m[2] as "accept" | "dismiss"));
		}
		throw new NexoError({ code: "NOT_FOUND", message: `No API route ${path}`, context: { path } });
	};

	const server: Server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			// Drains an unread request body so the error response is not cut off by a reset connection.
			req.resume();
			sendError(res, error);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", (cause) =>
			reject(
				new NexoError({
					code: "CONFIG_INVALID",
					message: `Cannot listen on ${host}:${options.port ?? 0}: ${(cause as Error).message}`,
					hint: "Pick another port with --port or set ui.port in your nexo config",
					context: { host, port: options.port ?? 0 },
					cause,
				}),
			),
		);
		server.listen(options.port ?? 0, host, () => resolve());
	});
	const port = (server.address() as AddressInfo).port;
	allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	return {
		url: `http://127.0.0.1:${port}/`,
		port,
		token,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	};
}
