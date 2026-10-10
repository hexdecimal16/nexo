import type { ServerResponse } from "node:http";
import { type ErrorPayload, type NexoErrorCode, toErrorPayload } from "@nexo/telemetry";

const STATUS: Partial<Record<NexoErrorCode, number>> = {
	INVALID_REQUEST: 400,
	CONFIG_INVALID: 400,
	FORBIDDEN: 403,
	TOOL_DENIED: 403,
	NOT_FOUND: 404,
	SKILL_NOT_FOUND: 404,
	METHOD_NOT_ALLOWED: 405,
	CONFLICT: 409,
	WRITE_CONFLICT: 409,
	BUDGET_EXCEEDED: 402,
	PROVIDER_RATE_LIMIT: 429,
	PROVIDER_UNAVAILABLE: 503,
	PROVIDER_TIMEOUT: 504,
};

/** HTTP status for an error code; anything unlisted (STORE_IO, INTERNAL, …) is a 500. */
export function httpStatusFor(code: NexoErrorCode): number {
	return STATUS[code] ?? 500;
}

export interface ErrorBody {
	error: { code: NexoErrorCode; message: string; retryable: boolean; hint: string | null; context: Record<string, unknown> };
}

/** The API error envelope; `hint` and `context` are always present so clients need no existence checks. */
export function errorBody(error: unknown): { status: number; body: ErrorBody } {
	const payload: ErrorPayload = toErrorPayload(error);
	return {
		status: httpStatusFor(payload.code),
		body: {
			error: {
				code: payload.code,
				message: payload.message,
				retryable: payload.retryable,
				hint: payload.hint ?? null,
				context: payload.context ?? {},
			},
		},
	};
}

export const SECURITY_HEADERS: Record<string, string> = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
	"cross-origin-resource-policy": "same-origin",
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		...SECURITY_HEADERS,
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
}

export function sendError(res: ServerResponse, error: unknown): void {
	const { status, body } = errorBody(error);
	if (res.headersSent) {
		res.destroy();
		return;
	}
	sendJson(res, status, body);
}
