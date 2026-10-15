import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type ErrorPayload, NexoError, type Redactor } from "@nexo/telemetry";
import type { HumanVerdict } from "./feedback.ts";
import type { RunStatus } from "./runs.ts";
import type { ScoreRow } from "./scores.ts";
import type { SpanRow } from "./spans.ts";
import { copyWorkspaceTree, emptyDir, type WorkspaceCopyOptions } from "./workspace-copy.ts";

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
	/** Approver spend of the run and its subagents, for audit only: not in `costUsd` and not charged to any budget. */
	approvalCostUsd?: number;
	tokensIn: number;
	tokensOut: number;
	output: string;
	error: ErrorPayload | null;
	artifactSetId: string | null;
	configSnapshotHash: string;
	workspace: string;
	taskGraphs: TaskGraphRecord[];
	/** Session link of a session turn's root run; absent or null otherwise. */
	sessionId?: string | null;
	turnIndex?: number | null;
	/** The latest human verdict; written by `recordFeedback` after the run ends. */
	humanVerdict?: HumanVerdict | null;
	/** Every scorer result of every scoring round; absent when the run was never scored. */
	scores?: ScoreRow[];
	/** System 1 → System 2 escalations that took effect. */
	escalations?: number;
	/** The optimization this run is a rollout of (or the optimizer's own run); absent or null otherwise. */
	optimRunId?: string | null;
	/**
	 * The session turn whose workspace this run's `workspace/` started as a copy of, and the bytes of regular files
	 * copied; absent when the run started with an empty or a shared workspace.
	 */
	workspaceFrom?: { runId: string; bytes: number };
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

	/**
	 * Copies a previous turn's workspace (`from.dir`, of run `from.runId`) into the empty `workspace/` folder and returns
	 * the bytes of regular files copied (see `copyWorkspaceTree`: a clone on macOS APFS and on Linux file systems with
	 * reflinks, a plain copy otherwise; symlinks copied as links). On failure or abort the folder is emptied again; a
	 * failure throws STORE_IO naming the source, an abort INTERNAL.
	 */
	async copyIntoWorkspace(from: { runId: string; dir: string }, options: WorkspaceCopyOptions = {}): Promise<number> {
		try {
			return await copyWorkspaceTree(from.dir, this.workspaceDir, options);
		} catch (cause) {
			try {
				await emptyDir(this.workspaceDir);
			} catch {}
			if (options.signal?.aborted) {
				throw new NexoError({ code: "INTERNAL", message: `The copy of run ${from.runId}'s workspace was aborted`, context: { source: from.dir }, cause });
			}
			throw new NexoError({
				code: "STORE_IO",
				message: `Cannot copy the workspace of the previous turn (run ${from.runId}, ${from.dir}) into ${this.workspaceDir}`,
				hint: `Check that ${from.dir} is readable and the disk has space; remove that folder to start the next turn from the turn before it (or empty)`,
				context: { sourceRunId: from.runId, source: from.dir, workspace: this.workspaceDir },
				cause,
			});
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

	get scoresDir(): string {
		return join(this.root, "scores");
	}

	/** Writes a scorer output (judge responses, command logs) under `scores/` and returns its path relative to the run directory. */
	writeScoreFile(relPath: string, content: string): string {
		this.writeConfined(this.scoresDir, relPath, content);
		return `scores/${relPath}`;
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

/** Reads trajectory.jsonl, skipping unparsable lines (such as a truncated last line); later records for the same span id replace earlier ones, keeping first-seen order. */
export function readTrajectory(dir: string): SpanRow[] {
	const file = join(dir, "trajectory.jsonl");
	if (!existsSync(file)) return [];
	const byId = new Map<string, SpanRow>();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const span = JSON.parse(line) as SpanRow;
			byId.set(span.id, span);
		} catch {
			continue;
		}
	}
	return [...byId.values()];
}
