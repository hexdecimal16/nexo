import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { type Effort, EFFORTS, isEffort, parseModelRef } from "@nexo/router";
import {
	type Db,
	type FeedbackRow,
	getSpent,
	latestSessionRunId,
	deleteSessionRow,
	listSessionRows,
	maxSessionTurn,
	newId,
	recordFeedback,
	SessionDir,
	type SessionJson,
	type SessionRow,
	sessionRowFromJson,
	type SessionStatus,
	type TranscriptLine,
	upsertSessionRow,
	type Verdict,
} from "@nexo/store";
import { createRedactor, type ErrorPayload, NexoError, type Redactor, toErrorPayload } from "@nexo/telemetry";
import type { NexoConfig } from "../config/schema.ts";
import { checkAdmission, sessionScope } from "../cost/admission.ts";
import { RunBudget } from "../cost/budget.ts";
import {
	createEngineEnv,
	type EngineDeps,
	type EngineEnv,
	type EngineEvent,
	executeRun,
	type HistoryPreparer,
	type RunModelInfo,
	type RunResult,
} from "../engine/run.ts";
import {
	activeMessageLines,
	buildHistory,
	COMPACTION_SYSTEM_PROMPT,
	KEEP_VERBATIM_TURNS,
	latestCompaction,
	renderForSummary,
	titleFrom,
} from "./transcript.ts";
import { SessionLock } from "./lock.ts";

const EPSILON = 1e-9;

/** Share of the s1 model's context window the compaction input may fill (at about 4 characters per token). */
const COMPACTION_INPUT_WINDOW_SHARE = 0.5;

/** Constructor guard: only this module's factories can build a Session. */
const INIT: unique symbol = Symbol("Session.init");

/** What a session needs: the engine's dependencies (with the caller's prompter) minus the event sink, which is per turn. */
export interface SessionDeps extends Omit<EngineDeps, "onEvent"> {
	/**
	 * Called before each turn; a config with a different hash takes effect from that turn, together with its redactor
	 * (`redact`, or one built from `config.redaction.patterns`).
	 */
	reloadConfig?: () => { config: NexoConfig; configHash: string; redact?: Redactor };
}

export interface CreateSessionOptions {
	/** Directory nexo was started in. */
	cwd: string;
	/** Directory the turns work in, resolved against `cwd`; defaults to `cwd`. */
	workspace?: string;
	/** Initial session-level overrides, as `/model` and `/effort` set them. */
	model?: string;
	effort?: Effort;
}

export interface TurnOptions {
	/** Aborts the turn; the partial turn is still recorded. */
	signal?: AbortSignal;
	/** Receives this turn's engine events (subagents included). */
	onEvent?: (event: EngineEvent) => void;
}

export type SessionSummary = SessionRow;

function invalid(message: string, hint?: string): NexoError {
	return new NexoError({ code: "INVALID_REQUEST", message, ...(hint ? { hint } : {}) });
}

function resolveWorkspace(cwd: string, workspace: string | undefined): string {
	const dir = resolve(cwd, workspace ?? ".");
	let isDir = false;
	try {
		isDir = statSync(dir).isDirectory();
	} catch {
		isDir = false;
	}
	if (!isDir) {
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: `Workspace ${dir} is not an existing directory`,
			hint: "Pass an existing directory to --workspace",
			context: { workspace: dir },
		});
	}
	return realpathSync(dir);
}

function refusedResult(error: ErrorPayload): RunResult {
	return { trajectoryId: null, runDir: null, status: "budget_exceeded", output: "", costUsd: 0, costUnknown: false, error, messages: [], model: null };
}

/** Request size of the turn's last call: what the model saw plus what it wrote. */
function contextTokens(messages: readonly Message[]): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		const u = (m as AssistantMessage).usage;
		const total = u.input + u.cacheRead + u.cacheWrite + u.output;
		if (total > 0) return total;
	}
	return null;
}

/**
 * A persistent conversation: each `turn` is one engine run that continues the session's transcript. State is saved to
 * `session.json`, `transcript.jsonl` and the `sessions` row after every change.
 */
export class Session {
	readonly id: string;
	private deps: SessionDeps;
	private dir: SessionDir;
	private readonly lock: SessionLock;
	private env: EngineEnv;
	private configHash: string;
	private state: SessionJson;
	private lines: TranscriptLine[];
	private lastModelInfo: RunModelInfo | null = null;
	private busy = false;
	private compactRequested = false;
	private onEvent: ((event: EngineEvent) => void) | undefined;

	/** Use `createSession` or `resumeSession`. Saves the state and takes ownership of `lock`. */
	constructor(init: typeof INIT, deps: SessionDeps, dir: SessionDir, state: SessionJson, lines: TranscriptLine[], lock: SessionLock) {
		if (init !== INIT) throw new NexoError({ code: "INTERNAL", message: "Use createSession or resumeSession" });
		this.id = state.id;
		this.deps = deps;
		this.dir = dir;
		this.state = state;
		this.lines = lines;
		this.lock = lock;
		this.configHash = deps.configHash;
		this.env = this.buildEnv(deps);
		this.save();
	}

	get dirPath(): string {
		return this.dir.root;
	}
	get title(): string {
		return this.state.title;
	}
	get cwd(): string {
		return this.state.cwd;
	}
	get workspace(): string {
		return this.state.workspace;
	}
	get status(): SessionStatus {
		return this.state.status;
	}
	get turns(): number {
		return this.state.turns;
	}
	get costUsd(): number {
		return this.state.costUsd;
	}
	/** The session cap: the `/budget` override, else `budgets.perSessionUsd` of the current config. */
	get budgetUsd(): number {
		return this.state.budgetOverrideUsd ?? this.env.deps.config.budgets.perSessionUsd;
	}
	/** The `/budget` override, or null when the cap follows the config. */
	get budgetOverrideUsd(): number | null {
		return this.state.budgetOverrideUsd ?? null;
	}
	get remainingUsd(): number {
		return Math.max(0, this.budgetUsd - this.state.costUsd);
	}
	/** The `/model` override, or null. */
	get model(): string | null {
		return this.state.model;
	}
	/** The `/effort` override, or null. */
	get effort(): Effort | null {
		return isEffort(this.state.effort) ? this.state.effort : null;
	}
	/** Model and effort the latest turn ran with (this process only); null before the first turn. */
	get lastModel(): RunModelInfo | null {
		return this.lastModelInfo;
	}
	/** The latest turn's request size as a fraction of its model's context window; null before the first turn. */
	get contextFraction(): number | null {
		const c = this.state.context;
		return c && c.window > 0 ? c.tokens / c.window : null;
	}
	get lastRunId(): string | null {
		return this.state.lastRunId;
	}
	get running(): boolean {
		return this.busy;
	}
	/** True after `compact()` until the next turn compacts. */
	get compactPending(): boolean {
		return this.compactRequested;
	}
	/** The transcript in order: message lines and compaction markers. Lines read from disk are redacted. */
	transcript(): readonly TranscriptLine[] {
		return this.lines;
	}

	/**
	 * Runs one turn. Refusals (session cap, daily or monthly cap) return a `budget_exceeded` result without a run.
	 * Throws INVALID_REQUEST for an empty instruction, a closed session or while another turn is running, and STORE_IO
	 * when the session cannot be saved.
	 */
	async turn(instruction: string, options: TurnOptions = {}): Promise<RunResult> {
		if (!instruction.trim()) throw invalid("The message is empty");
		if (this.state.status === "closed") throw invalid(`Session ${this.id} is closed`, "Resume it with `nexo --resume`");
		if (this.busy) throw invalid("A turn is already running", "Wait for it to finish or abort it");
		this.busy = true;
		try {
			this.reloadConfig();
			const { config } = this.env.deps;
			const remaining = this.remainingUsd;
			if (remaining <= EPSILON) {
				return refusedResult(
					new NexoError({
						code: "BUDGET_EXCEEDED",
						message: `Session budget of $${this.budgetUsd.toFixed(2)} is exhausted ($${this.state.costUsd.toFixed(4)} spent)`,
						hint: "Raise it for this session with /budget <usd>, or raise budgets.perSessionUsd in your nexo config",
						context: { sessionId: this.id, limitUsd: this.budgetUsd, spentUsd: this.state.costUsd },
					}).toPayload(),
				);
			}
			try {
				checkAdmission(this.deps.db, config.budgets, this.env.now());
			} catch (error) {
				return refusedResult(this.env.deps.redact(toErrorPayload(error)));
			}
			const turnIndex = this.state.turns + 1;
			this.onEvent = options.onEvent;
			const result = await executeRun(this.env, {
				request: {
					instruction,
					history: buildHistory(this.lines, this.env.now().getTime()),
					prepareHistory: this.compactionHook(turnIndex),
					sessionId: this.id,
					turnIndex,
					workspace: this.state.workspace,
					...(this.state.model ? { model: this.state.model } : {}),
					...(this.effort ? { effort: this.effort } : {}),
				},
				budget: new RunBudget(Math.min(config.budgets.perRunUsd, remaining)),
				signal: options.signal,
			});
			if (result.trajectoryId !== null) this.recordTurn(turnIndex, instruction, result);
			return result;
		} finally {
			this.onEvent = undefined;
			this.busy = false;
		}
	}

	/** Sets this session's cap in USD (overrides `budgets.perSessionUsd`). */
	setBudget(usd: number): void {
		if (!Number.isFinite(usd) || usd <= 0) throw invalid(`Budget must be a positive number of USD, got ${usd}`, "Example: /budget 10");
		this.state.budgetOverrideUsd = usd;
		this.save();
	}

	/** Sets the session's model override ("s1", "s2" or "provider/model-id"); null clears it. */
	setModel(ref: string | null): void {
		if (ref !== null) {
			try {
				const { config } = this.env.deps;
				const parsed = parseModelRef(ref, { s1: config.models.s1, s2: config.models.s2 });
				this.env.registry.get(parsed.provider, parsed.id);
			} catch (error) {
				const e = error instanceof NexoError ? error : undefined;
				throw new NexoError({
					code: "INVALID_REQUEST",
					message: e?.message ?? `Unknown model "${ref}"`,
					hint: 'Use "s1", "s2" or "provider/model-id" from pi-ai\'s catalog',
					context: { ref },
					cause: error,
				});
			}
		}
		this.state.model = ref;
		this.save();
	}

	/** Sets the session's effort override; null clears it. */
	setEffort(level: Effort | null): void {
		if (level !== null && !isEffort(level)) throw invalid(`Effort must be one of ${EFFORTS.join(", ")}, got "${String(level)}"`);
		this.state.effort = level;
		this.save();
	}

	/** Compacts older turns at the start of the next turn, whatever the context size. */
	compact(): void {
		this.assertIdle();
		this.compactRequested = true;
	}

	/** Starts a new conversation in the same session: a compaction marker with an empty summary. */
	clear(): void {
		this.assertIdle();
		this.appendLines([{ type: "compaction", turnIndex: this.state.turns, summary: "", replacedThroughTurn: this.state.turns }]);
		this.compactRequested = false;
		this.state.context = null;
		this.save();
	}

	/** Records a verdict on the latest turn (spec §7.1 feedback). Throws INVALID_REQUEST before the first turn. */
	review(verdict: Verdict, comment?: string): FeedbackRow {
		const runId = this.state.lastRunId;
		if (!runId) throw invalid("There is no turn to review yet");
		return recordFeedback(this.deps.db, { runId, verdict, comment, nowIso: this.env.now().toISOString(), redact: this.env.deps.redact });
	}

	/** Marks the session closed and releases its lock; a session that never ran a turn is deleted instead; `resumeSession` reopens it. Throws CONFLICT while a turn runs. */
	close(): void {
		if (this.busy) {
			throw new NexoError({ code: "CONFLICT", message: "A turn is running", hint: "Abort the turn (its signal) and wait for it to finish before closing" });
		}
		if (this.state.status === "closed") return;
		this.state.status = "closed";
		if (this.isEmpty()) {
			// Nothing happened: leave no empty session behind. The lock goes last, so nobody can resume a half-deleted session.
			this.dir.remove();
			deleteSessionRow(this.deps.db, this.id);
			this.lock.release();
			return;
		}
		this.save();
		this.lock.release();
	}

	/** No turn, cost or run: in memory and in the database, which stays the source of truth after a failed save. */
	private isEmpty(): boolean {
		return (
			this.state.turns === 0 &&
			this.state.costUsd === 0 &&
			!this.state.lastRunId &&
			latestSessionRunId(this.deps.db, this.id) === undefined &&
			getSpent(this.deps.db, sessionScope(this.id)) === 0
		);
	}

	private assertIdle(): void {
		if (this.busy) throw invalid("A turn is running", "Wait for it to finish or abort it");
	}

	private buildEnv(deps: SessionDeps): EngineEnv {
		const { reloadConfig: _reload, ...engineDeps } = deps;
		return createEngineEnv({ ...engineDeps, onEvent: (event) => this.onEvent?.(event) });
	}

	private reloadConfig(): void {
		if (!this.deps.reloadConfig) return;
		const next = this.deps.reloadConfig();
		if (next.configHash === this.configHash) return;
		this.configHash = next.configHash;
		const redact = next.redact ?? createRedactor(next.config.redaction.patterns);
		this.deps = { ...this.deps, config: next.config, configHash: next.configHash, redact };
		this.dir = new SessionDir(this.dir.root, this.id, redact);
		this.env = this.buildEnv(this.deps);
	}

	/** Compacts before the turn's first request when forced or when the request would pass `session.compactAt`. */
	private compactionHook(turnIndex: number): HistoryPreparer {
		return async (ctx) => {
			const threshold = this.env.deps.config.session.compactAt * ctx.model.contextWindow;
			if (!this.compactRequested && ctx.estimateTokens(ctx.history) <= threshold) return ctx.history;
			const active = activeMessageLines(this.lines);
			const turnIndexes = [...new Set(active.map((l) => l.turnIndex))].sort((a, b) => a - b);
			const replacedThroughTurn = turnIndexes[turnIndexes.length - KEEP_VERBATIM_TURNS - 1];
			if (replacedThroughTurn === undefined) {
				this.compactRequested = false;
				return ctx.history;
			}
			const old = active.filter((l) => l.turnIndex <= replacedThroughTurn).map((l) => l.message as Message);
			const { config } = this.env.deps;
			const s1 = this.env.registry.get(config.models.s1.provider, config.models.s1.id);
			const maxChars = Math.floor(s1.contextWindow * COMPACTION_INPUT_WINDOW_SHARE * 4) - COMPACTION_SYSTEM_PROMPT.length;
			const text = renderForSummary(latestCompaction(this.lines)?.summary ?? "", old, maxChars);
			let summary: string;
			try {
				summary = await ctx.summarize({ system: COMPACTION_SYSTEM_PROMPT, text });
			} catch (error) {
				if (ctx.signal?.aborted) throw error;
				this.deps.logger.warn("compaction failed; continuing with the full history", { session_id: this.id, error });
				return ctx.history;
			}
			this.compactRequested = false;
			this.appendLines([{ type: "compaction", turnIndex, summary, replacedThroughTurn }]);
			return buildHistory(this.lines, this.env.now().getTime());
		};
	}

	private recordTurn(turnIndex: number, instruction: string, result: RunResult): void {
		// A run that ended before its first request returns no messages; the instruction is kept so it is not lost.
		const messages: Message[] =
			result.messages.length > 0 ? result.messages : [{ role: "user", content: [{ type: "text", text: instruction }], timestamp: this.env.now().getTime() }];
		this.appendLines(messages.map((message) => ({ type: "message", turnIndex, message })));
		this.state.turns = turnIndex;
		this.state.costUsd += result.costUsd;
		this.state.lastRunId = result.trajectoryId;
		if (!this.state.title) this.state.title = titleFrom(this.env.deps.redact(instruction));
		if (result.model) {
			this.lastModelInfo = result.model;
			const tokens = contextTokens(result.messages);
			if (tokens !== null) this.state.context = { tokens, window: result.model.contextWindow };
		}
		this.save();
	}

	private appendLines(lines: TranscriptLine[]): void {
		this.dir.appendTranscript(lines);
		this.lines.push(...lines);
	}

	private save(): void {
		this.state.updatedAt = this.env.now().toISOString();
		this.state.budgetUsd = this.budgetUsd;
		this.state.budgetOverrideUsd = this.state.budgetOverrideUsd ?? null;
		this.dir.writeSessionJson(this.state);
		upsertSessionRow(this.deps.db, sessionRowFromJson(this.env.deps.redact(this.state), this.dir.root));
	}
}

/** Builds a session under `lock`, releasing the lock if construction fails. */
function openSession(deps: SessionDeps, dir: SessionDir, state: SessionJson, lines: TranscriptLine[], lock: SessionLock): Session {
	try {
		return new Session(INIT, deps, dir, state, lines, lock);
	} catch (error) {
		lock.release();
		throw error;
	}
}

/** Starts a new session in `options.cwd` (or `options.workspace`), with the cap from `budgets.perSessionUsd`. */
export function createSession(deps: SessionDeps, options: CreateSessionOptions): Session {
	const workspace = resolveWorkspace(options.cwd, options.workspace);
	const id = newId();
	const nowIso = (deps.now ?? (() => new Date()))().toISOString();
	const state: SessionJson = {
		id,
		title: "",
		cwd: resolve(options.cwd),
		workspace,
		model: null,
		effort: null,
		budgetUsd: deps.config.budgets.perSessionUsd,
		budgetOverrideUsd: null,
		costUsd: 0,
		turns: 0,
		status: "active",
		createdAt: nowIso,
		updatedAt: nowIso,
		lastRunId: null,
		context: null,
	};
	const dir = SessionDir.create(deps.paths.sessions, id, deps.redact);
	const session = openSession(deps, dir, state, [], SessionLock.acquire(dir.root, id));
	try {
		if (options.model !== undefined) session.setModel(options.model);
		if (options.effort !== undefined) session.setEffort(options.effort);
	} catch (error) {
		session.close();
		throw error;
	}
	return session;
}

/**
 * Reopens a session from its directory as `active`, rebuilding the history from the transcript. Throws NOT_FOUND for an
 * unknown id, CONFLICT when another live process has it open, and STORE_IO for an unreadable session.json.
 */
export function resumeSession(deps: SessionDeps, id: string): Session {
	const dir = SessionDir.open(deps.paths.sessions, id, deps.redact);
	const lock = SessionLock.acquire(dir.root, id);
	let state: SessionJson;
	try {
		state = dir.readSessionJson();
		// A turn that crashed before session.json was saved still has its spend in the ledger and its run in the index.
		state.costUsd = Math.max(state.costUsd, getSpent(deps.db, sessionScope(id)));
		const indexedTurns = maxSessionTurn(deps.db, id);
		if (indexedTurns > state.turns) {
			state.turns = indexedTurns;
			state.lastRunId = latestSessionRunId(deps.db, id) ?? state.lastRunId;
		}
		state.status = "active";
	} catch (error) {
		lock.release();
		throw error;
	}
	return openSession(deps, dir, state, dir.readTranscript(), lock);
}

/** Indexed sessions that ran at least one turn, most recently updated first. Throws INVALID_REQUEST for a limit outside 1..1000. */
export function listSessions(db: Db, options: { limit?: number } = {}): SessionSummary[] {
	const limit = options.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalid(`limit must be an integer from 1 to 1000, got ${limit}`);
	return listSessionRows(db, { limit, withTurns: true });
}
