export type NexoErrorCode =
	| "CONFIG_INVALID"
	| "PROVIDER_AUTH"
	| "PROVIDER_RATE_LIMIT"
	| "PROVIDER_UNAVAILABLE"
	| "PROVIDER_TIMEOUT"
	| "PROVIDER_CONTEXT_OVERFLOW"
	| "BUDGET_EXCEEDED"
	| "LOOP_LIMIT"
	| "TOOL_DENIED"
	| "WRITE_CONFLICT"
	| "MODEL_NOT_ALLOWED"
	| "TASK_GRAPH_CYCLE"
	| "TASK_GRAPH_INVALID"
	| "SCORER_FAILED"
	| "EVAL_SET_TOO_SMALL"
	| "SKILL_INVALID"
	| "SKILL_NOT_FOUND"
	| "STORE_IO"
	| "MCP_UNAVAILABLE"
	| "INVALID_REQUEST"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "METHOD_NOT_ALLOWED"
	| "CONFLICT"
	| "INTERNAL";

export interface ErrorPayload {
	code: NexoErrorCode;
	message: string;
	retryable: boolean;
	hint?: string;
	context?: Record<string, unknown>;
}

export interface NexoErrorOptions {
	code: NexoErrorCode;
	message: string;
	retryable?: boolean;
	hint?: string;
	context?: Record<string, unknown>;
	cause?: unknown;
}

/** Structured error carried across every nexo boundary (CLI, run.json, tool results). */
export class NexoError extends Error {
	readonly code: NexoErrorCode;
	readonly retryable: boolean;
	readonly hint: string | undefined;
	readonly context: Record<string, unknown> | undefined;

	constructor(options: NexoErrorOptions) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "NexoError";
		this.code = options.code;
		this.retryable = options.retryable ?? false;
		this.hint = options.hint;
		this.context = options.context;
	}

	toPayload(): ErrorPayload {
		const payload: ErrorPayload = { code: this.code, message: this.message, retryable: this.retryable };
		if (this.hint !== undefined) payload.hint = this.hint;
		if (this.context !== undefined) payload.context = this.context;
		return payload;
	}
}

export function toErrorPayload(error: unknown): ErrorPayload {
	if (error instanceof NexoError) return error.toPayload();
	if (error instanceof Error) return { code: "INTERNAL", message: error.message, retryable: false };
	if (typeof error === "string") return { code: "INTERNAL", message: error, retryable: false };
	return { code: "INTERNAL", message: "Unknown error", retryable: false };
}
