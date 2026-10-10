import { type Db, insertSpan, newId, type RunDir, type SpanKind, type SpanRow, updateSpan } from "@nexo/store";
import type { Redactor } from "@nexo/telemetry";

export interface StartSpanInput {
	kind: SpanKind;
	name: string;
	parentSpanId: string | null;
	model?: string | null;
	provider?: string | null;
	tier?: string | null;
	effort?: string | null;
	modelSource?: string | null;
	queuedMs?: number | null;
	attrs?: Record<string, unknown>;
}

export type SpanFinish = Partial<
	Pick<SpanRow, "status" | "tokensIn" | "tokensOut" | "cacheRead" | "cacheWrite" | "costUsd" | "costUnknown" | "payloadRef" | "queuedMs">
> & { attrs?: Record<string, unknown> };

export interface RecorderDeps {
	db: Db;
	runDir: RunDir;
	runId: string;
	now: () => Date;
	redact: Redactor;
}

/**
 * Writes each span to SQLite (redacted) and appends a full snapshot to trajectory.jsonl (redacted by RunDir) on start
 * and on finish. The in-memory copy keeps the raw values so later `finish` merges see the original attrs.
 */
export class Recorder {
	private readonly deps: RecorderDeps;
	private readonly spans = new Map<string, SpanRow>();

	constructor(deps: RecorderDeps) {
		this.deps = deps;
	}

	start(input: StartSpanInput): string {
		const span: SpanRow = {
			id: newId(),
			runId: this.deps.runId,
			parentSpanId: input.parentSpanId,
			kind: input.kind,
			name: input.name,
			status: "running",
			startedAt: this.deps.now().toISOString(),
			endedAt: null,
			queuedMs: input.queuedMs ?? null,
			model: input.model ?? null,
			provider: input.provider ?? null,
			tier: input.tier ?? null,
			effort: input.effort ?? null,
			modelSource: input.modelSource ?? null,
			tokensIn: 0,
			tokensOut: 0,
			cacheRead: 0,
			cacheWrite: 0,
			costUsd: 0,
			costUnknown: false,
			payloadRef: null,
			attrs: input.attrs ?? {},
		};
		this.spans.set(span.id, span);
		insertSpan(this.deps.db, this.deps.redact(span));
		this.deps.runDir.appendTrajectory(span);
		return span.id;
	}

	finish(id: string, patch: SpanFinish): void {
		const current = this.spans.get(id);
		if (!current) return;
		const { attrs, ...rest } = patch;
		const next: SpanRow = {
			...current,
			...rest,
			status: patch.status ?? "ok",
			endedAt: this.deps.now().toISOString(),
			attrs: { ...current.attrs, ...attrs },
		};
		this.spans.set(id, next);
		updateSpan(this.deps.db, id, this.deps.redact(next));
		this.deps.runDir.appendTrajectory(next);
	}

	get(id: string): SpanRow | undefined {
		return this.spans.get(id);
	}
}
