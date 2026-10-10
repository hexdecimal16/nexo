import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type ErrorPayload, NexoError, type Redactor } from "@nexo/telemetry";
import type { RunStatus } from "./runs.ts";
import type { SpanRow } from "./spans.ts";

export interface ResolvedModelInfo {
	provider: string;
	id: string;
	effort: string;
	source: string;
	role: string | null;
}

export interface TaskGraphRecord {
	spawnSpanId: string | null;
	planned: unknown[];
	executed: unknown[];
}

export interface RunJson {
	id: string;
	parentRunId: string | null;
	rootRunId: string;
	instruction: string;
	skill: string | null;
	status: RunStatus;
	model: ResolvedModelInfo | null;
	startedAt: string;
	endedAt: string | null;
	costUsd: number;
	costUnknown: boolean;
	tokensIn: number;
	tokensOut: number;
	output: string;
	error: ErrorPayload | null;
	artifactSetId: string | null;
	configSnapshotHash: string;
	workspace: string;
	taskGraphs: TaskGraphRecord[];
}

const SUBDIRS = ["artifacts", "context", "workspace", "tool_outputs", "scores", "subagents"] as const;

/** One trajectory's directory (`~/.nexo/runs/{id}` or `.../subagents/{id}`). Every write is redacted. */
export class RunDir {
	readonly id: string;
	readonly root: string;
	private readonly redact: Redactor;

	constructor(root: string, id: string, redact: Redactor) {
		this.root = root;
		this.id = id;
		this.redact = redact;
	}

	static create(runsRoot: string, id: string, redact: Redactor): RunDir {
		const dir = new RunDir(join(runsRoot, id), id, redact);
		dir.init();
		return dir;
	}

	child(childId: string): RunDir {
		const dir = new RunDir(join(this.root, "subagents", childId), childId, this.redact);
		dir.init();
		return dir;
	}

	get workspaceDir(): string {
		return join(this.root, "workspace");
	}
	get changesDir(): string {
		return join(this.root, "changes");
	}
	get artifactsDir(): string {
		return join(this.root, "artifacts");
	}
	get toolOutputsDir(): string {
		return join(this.root, "tool_outputs");
	}
	get contextDir(): string {
		return join(this.root, "context");
	}

	init(): void {
		try {
			for (const sub of SUBDIRS) mkdirSync(join(this.root, sub), { recursive: true });
		} catch (cause) {
			throw new NexoError({ code: "STORE_IO", message: `Cannot create run directory ${this.root}`, cause });
		}
	}

	writeRunJson(run: RunJson): void {
		const target = join(this.root, "run.json");
		const tmp = `${target}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(this.redact(run), null, 2)}\n`);
		renameSync(tmp, target);
	}

	appendTrajectory(span: SpanRow): void {
		appendFileSync(join(this.root, "trajectory.jsonl"), `${JSON.stringify(this.redact(span))}\n`);
	}

	writeArtifact(relPath: string, content: string): string {
		return this.writeConfined(this.artifactsDir, relPath, content);
	}

	writeContext(relPath: string, content: string): string {
		return this.writeConfined(this.contextDir, relPath, content);
	}

	/** Stores a large tool result and returns its path relative to the run directory. */
	writeToolOutput(spanId: string, content: string): string {
		this.writeConfined(this.toolOutputsDir, `${spanId}.txt`, content);
		return `tool_outputs/${spanId}.txt`;
	}

	resolveFile(relPath: string): string {
		return confine(this.root, relPath);
	}

	private writeConfined(base: string, relPath: string, content: string): string {
		const target = confine(base, relPath);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, this.redact(content));
		return target;
	}
}

/**
 * Lexical confinement for names inside a run directory (artifact and tool-output paths that nexo itself chooses).
 * The agent's workspace uses `resolveConfined` in `@nexo/tools`, which resolves through realpath instead.
 */
function confine(base: string, relPath: string): string {
	const target = resolve(base, relPath);
	if (target !== base && !target.startsWith(base + sep)) {
		throw new NexoError({
			code: "STORE_IO",
			message: `Path "${relPath}" escapes ${base}`,
			context: { base, relPath, relative: relative(base, target) },
		});
	}
	return target;
}

export function readRunJson(dir: string): RunJson {
	return JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunJson;
}

/** Reads trajectory.jsonl; later records for the same span id replace earlier ones, keeping first-seen order. */
export function readTrajectory(dir: string): SpanRow[] {
	const file = join(dir, "trajectory.jsonl");
	if (!existsSync(file)) return [];
	const byId = new Map<string, SpanRow>();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const span = JSON.parse(line) as SpanRow;
		byId.set(span.id, span);
	}
	return [...byId.values()];
}
