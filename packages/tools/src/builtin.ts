import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { NexoError } from "@nexo/telemetry";
import { Type } from "typebox";
import type { ChangeTracker } from "./change-tracker.ts";
import { canonicalPath, nexoHomeGuard, resolveConfined, SECRET_PATH } from "./confine.ts";
import type { FileLeases } from "./leases.ts";

export const MAX_BASH_OUTPUT_BYTES = 1_000_000;
const MAX_READ_LINES = 2000;
const MAX_FETCH_CHARS = 100_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_READ_BATCH = 20;

/** Paths with this prefix open the run's saved large tool outputs (`tool_outputs/` in the run directory) with `read`. */
export const TOOL_OUTPUT_PREFIX = "@tool_outputs/";

const liveBashGroups = new Set<number>();
let exitHandlerRegistered = false;

export function killLiveBashGroups(): void {
	for (const pgid of liveBashGroups) {
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {
			// the process group already exited
		}
	}
	liveBashGroups.clear();
}

export function trackedBashGroups(): number[] {
	return [...liveBashGroups];
}

function ensureExitHandler(): void {
	if (exitHandlerRegistered) return;
	exitHandlerRegistered = true;
	process.on("exit", killLiveBashGroups);
}

export interface BashRun {
	command: string;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** The command's environment; the process environment when left out. */
	env?: NodeJS.ProcessEnv;
}

export interface BashOutcome {
	/** stdout and stderr interleaved, at most MAX_BASH_OUTPUT_BYTES; the start error's message when `ended` is "failed". */
	output: string;
	/** Null unless `ended` is "exited". */
	exitCode: number | null;
	truncated: boolean;
	ended: "exited" | "timeout" | "aborted" | "failed";
}

/** Runs `command` with `bash -c` in its own process group, killed on timeout, abort or host exit. Never rejects. */
export function runBash(run: BashRun): Promise<BashOutcome> {
	const { signal } = run;
	return new Promise((resolvePromise) => {
		if (signal?.aborted) return resolvePromise({ output: "", exitCode: null, truncated: false, ended: "aborted" });
		const child = spawn("bash", ["-c", run.command], { cwd: run.cwd, env: run.env ?? process.env, detached: true });
		const pgid = child.pid;
		if (pgid !== undefined) {
			ensureExitHandler();
			liveBashGroups.add(pgid);
		}
		const killGroup = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// the process group already exited
			}
		};
		const chunks: Buffer[] = [];
		let captured = 0;
		let truncated = false;
		let ended: "timeout" | "aborted" | undefined;
		const collect = (chunk: Buffer) => {
			const room = MAX_BASH_OUTPUT_BYTES - captured;
			if (chunk.length > room) truncated = true;
			if (room <= 0) return;
			const part = chunk.subarray(0, room);
			chunks.push(part);
			captured += part.length;
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => {
			ended = "timeout";
			killGroup();
		}, run.timeoutMs);
		const onAbort = () => {
			ended = "aborted";
			killGroup();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("close", (code) => {
			if (pgid !== undefined) liveBashGroups.delete(pgid);
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const output = new StringDecoder("utf8").write(Buffer.concat(chunks));
			resolvePromise({ output, exitCode: ended ? null : (code ?? -1), truncated, ended: ended ?? "exited" });
		});
		child.on("error", (error) => {
			if (pgid !== undefined) liveBashGroups.delete(pgid);
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({ output: error.message, exitCode: null, truncated: false, ended: "failed" });
		});
	});
}

export interface ToolContext {
	workspaceRoot: string;
	holder: string;
	leases: FileLeases;
	changeTracker?: ChangeTracker;
	bashTimeoutMs: number;
	/** The run's `tool_outputs/` directory, readable through TOOL_OUTPUT_PREFIX paths. */
	toolOutputsDir?: string;
	/** Further `tool_outputs/` directories searched, in order, for a TOOL_OUTPUT_PREFIX path not in `toolOutputsDir` (earlier turns of a session). */
	earlierToolOutputsDirs?: () => readonly string[];
	fetch?: typeof fetch;
	/** The nexo home: write and edit are denied inside it (except in `runWorkspace`), read of its credentials file too. */
	nexoHome?: string;
	/** The run's own `workspace/` folder, the one place inside the nexo home that write and edit may change. */
	runWorkspace?: string;
	/** Absolute directories outside the workspace (the wikis) that read, write and edit may reach by absolute path; write and edit are allowed there even inside the nexo home. */
	wikiRoots?: readonly string[];
}

function textResult(text: string, isError = false): AgentToolResult<undefined> {
	return isError ? { content: [{ type: "text", text }], details: undefined, isError: true } : { content: [{ type: "text", text }], details: undefined };
}

const ReadParams = Type.Object({
	path: Type.Optional(Type.String({ description: "File path: relative to the workspace, or absolute" })),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based first line" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines" })),
	paths: Type.Optional(
		Type.Array(
			Type.Object({
				path: Type.String(),
				offset: Type.Optional(Type.Integer({ minimum: 1 })),
				limit: Type.Optional(Type.Integer({ minimum: 1 })),
			}),
			{ minItems: 1, maxItems: MAX_READ_BATCH, description: "Several files in one call, each with its own offset and limit; use instead of path" },
		),
	),
});
const WriteParams = Type.Object({ path: Type.String(), content: Type.String() });
const EditParams = Type.Object({
	path: Type.String(),
	oldText: Type.String({ description: "Exact text to replace; must occur exactly once" }),
	newText: Type.String(),
});
const BashParams = Type.Object({
	command: Type.String(),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
});
const FetchParams = Type.Object({ url: Type.String({ description: "http(s) URL" }) });

export function createBuiltinTools(ctx: ToolContext): AgentTool<any>[] {
	const root = realpathSync(ctx.workspaceRoot);
	const guard = ctx.nexoHome === undefined ? null : nexoHomeGuard(ctx.nexoHome, root, ctx.runWorkspace, ctx.wikiRoots);
	/** A tool path argument made absolute (relative paths start at the workspace) and resolved through realpath. Not confined to the workspace. */
	const resolvePath = (target: string): string => canonicalPath(target, root);

	/** Reads are not confined to the workspace. Outside it, key, token and credential files are refused: bash reads them through approval. */
	const resolveReadPath = (target: string): string => {
		const abs = canonicalPath(target, root);
		if (abs !== root && !abs.startsWith(root + sep) && SECRET_PATH.test(abs)) {
			throw new NexoError({
				code: "TOOL_DENIED",
				message: `Path "${target}" looks like a key, token or credential file`,
				hint: "Read it with bash, which asks for approval",
				context: { target },
			});
		}
		return abs;
	};
	const writeFile = (abs: string, content: string): void => {
		ctx.leases.acquire(abs, ctx.holder);
		if (abs === root || abs.startsWith(root + sep)) ctx.changeTracker?.beforeWrite(abs);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	};

	/** A saved output path in the run's own directory, else in the first earlier directory that has it. */
	const resolveSavedOutput = (outputs: string, path: string): string => {
		const name = path.slice(TOOL_OUTPUT_PREFIX.length);
		for (const dir of [outputs, ...(ctx.earlierToolOutputsDirs?.() ?? [])]) {
			if (!existsSync(dir)) continue;
			const abs = resolveConfined(dir, name);
			if (existsSync(abs)) return abs;
		}
		throw new Error(`File not found: ${path}`);
	};

	const readOne = (path: string, offset?: number, limit?: number): string => {
		const outputs = ctx.toolOutputsDir;
		const savedOutput = outputs !== undefined && path.startsWith(TOOL_OUTPUT_PREFIX);
		const abs = savedOutput ? resolveSavedOutput(outputs, path) : resolveReadPath(path);
		guard?.checkRead(abs);
		if (!existsSync(abs)) throw new Error(`File not found: ${path}`);
		const lines = readFileSync(abs, "utf8").split("\n");
		const start = (offset ?? 1) - 1;
		return lines.slice(start, start + (limit ?? MAX_READ_LINES)).join("\n");
	};

	const read: AgentTool<typeof ReadParams> = {
		name: "read",
		label: "Read file",
		description: `Read text files. Relative paths start at the workspace; absolute paths are read where they are, except key, token and credential files (use bash for those). Pass paths to read several files in one call. Paths starting with ${TOOL_OUTPUT_PREFIX} open saved large tool outputs.`,
		parameters: ReadParams,
		execute: async (_id, params) => {
			if (params.paths !== undefined) {
				if (params.path !== undefined) throw new Error("Give either path or paths, not both");
				const parts = params.paths.map((p) => {
					try {
						return { failed: false, text: `==> ${p.path} <==\n${readOne(p.path, p.offset, p.limit)}` };
					} catch (error) {
						return { failed: true, text: `==> ${p.path} <==\n[error] ${error instanceof Error ? error.message : String(error)}` };
					}
				});
				return textResult(parts.map((p) => p.text).join("\n\n"), parts.every((p) => p.failed));
			}
			if (params.path === undefined) throw new Error("Give path or paths");
			return textResult(readOne(params.path, params.offset, params.limit));
		},
	};

	const write: AgentTool<typeof WriteParams> = {
		name: "write",
		label: "Write file",
		description: "Create or overwrite a file. Relative paths start at the workspace; absolute paths are written where they are.",
		parameters: WriteParams,
		execute: async (_id, params) => {
			const abs = resolvePath(params.path);
			guard?.checkWrite(abs);
			writeFile(abs, params.content);
			return textResult(`Wrote ${Buffer.byteLength(params.content)} bytes to ${relative(root, abs) || params.path}`);
		},
	};

	const edit: AgentTool<typeof EditParams> = {
		name: "edit",
		label: "Edit file",
		description: "Replace one exact, unique occurrence of oldText with newText.",
		parameters: EditParams,
		execute: async (_id, params) => {
			if (params.oldText === "") throw new Error("oldText must not be empty");
			const abs = resolvePath(params.path);
			guard?.checkWrite(abs);
			if (!existsSync(abs)) throw new Error(`File not found: ${params.path}`);
			const content = readFileSync(abs, "utf8");
			const count = content.split(params.oldText).length - 1;
			if (count === 0) throw new Error(`oldText not found in ${params.path}`);
			if (count > 1) throw new Error(`oldText matches ${count} times in ${params.path}; include more surrounding text`);
			writeFile(abs, content.replace(params.oldText, () => params.newText));
			return textResult(`Edited ${params.path}`);
		},
	};

	const bash: AgentTool<typeof BashParams> = {
		name: "bash",
		label: "Run command",
		description: "Run a bash command in the workspace directory.",
		parameters: BashParams,
		execute: async (_id, params, signal) => {
			const timeoutMs = params.timeoutMs ?? ctx.bashTimeoutMs;
			const r = await runBash({ command: params.command, cwd: root, timeoutMs, signal });
			const body = `${r.output}${r.truncated ? "\n[output truncated]" : ""}`;
			switch (r.ended) {
				case "failed":
					return textResult(`Failed to start bash: ${r.output}`, true);
				case "timeout":
					return textResult(`Command timed out after ${timeoutMs}ms and was killed with its child processes.\nFor a long job, start it in the background (nohup <command> > job.log 2>&1 &) and poll job.log, or pass a larger timeoutMs.\n${body}`, true);
				case "aborted":
					return textResult(`Command aborted\n${body}`, true);
				case "exited":
					return textResult(`exit code: ${r.exitCode ?? -1}\n${body}`, r.exitCode !== 0);
			}
		},
	};

	const webFetch: AgentTool<typeof FetchParams> = {
		name: "web_fetch",
		label: "Fetch URL",
		description: "Fetch an http(s) URL and return the response body as text.",
		parameters: FetchParams,
		execute: async (_id, params, signal) => {
			const url = new URL(params.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https URLs are allowed: ${params.url}`);
			const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])];
			const response = await (ctx.fetch ?? fetch)(url.toString(), { signal: AbortSignal.any(signals) });
			const body = (await response.text()).slice(0, MAX_FETCH_CHARS);
			if (!response.ok) return textResult(`HTTP ${response.status} for ${params.url}\n${body}`, true);
			return textResult(body);
		},
	};

	return [read, write, edit, bash, webFetch];
}
