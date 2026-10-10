import { NexoError } from "@nexo/telemetry";

/** A request the caller can fix: bad filter, bad body field, bad path. Maps to HTTP 400. */
export function invalidRequest(message: string, context: Record<string, unknown> = {}, hint?: string): NexoError {
	return new NexoError({ code: "INVALID_REQUEST", message, context, ...(hint ? { hint } : {}) });
}

/** The one NOT_FOUND error for an unknown run id, shared by the store and the web API. */
export function runNotFound(runId: string): NexoError {
	return new NexoError({ code: "NOT_FOUND", message: `Run ${runId} does not exist`, context: { runId } });
}
