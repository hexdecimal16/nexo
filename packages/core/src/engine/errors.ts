import type { AgentTool } from "@earendil-works/pi-agent-core";
import { NexoError } from "@nexo/telemetry";

/** Maps a provider error message (pi encodes failures as text) to a NexoError code and hint. */
export function classifyProviderError(message: string): NexoError {
	const lower = message.toLowerCase();
	if (/\b(401|403)\b|unauthori|invalid.*api.?key|no api key|authentication|permission denied/.test(lower)) {
		return new NexoError({
			code: "PROVIDER_AUTH",
			message,
			hint: "Set the provider's API key environment variable (for example ANTHROPIC_API_KEY or OPENAI_API_KEY) or log in with pi-ai",
		});
	}
	if (/\b429\b|rate.?limit|too many requests|resource.?exhausted/.test(lower)) {
		return new NexoError({ code: "PROVIDER_RATE_LIMIT", message, retryable: true, hint: "Lower providers.<name>.maxConcurrent or retry later" });
	}
	if (/timed? ?out|timeout|etimedout/.test(lower)) {
		return new NexoError({ code: "PROVIDER_TIMEOUT", message, retryable: true, hint: "Retry the run; check network connectivity" });
	}
	if (/\b400\b|bad request|invalid_argument|invalid_request_error/.test(lower)) {
		return new NexoError({
			code: "PROVIDER_UNAVAILABLE",
			message,
			hint: "The provider rejected the request as invalid (HTTP 400); retrying sends the same request. The message above says which part it refused",
		});
	}
	return new NexoError({ code: "PROVIDER_UNAVAILABLE", message, retryable: true, hint: "The provider returned an error; retry later" });
}

export function contextOverflowError(message: string): NexoError {
	return new NexoError({
		code: "PROVIDER_CONTEXT_OVERFLOW",
		message,
		hint: "The conversation no longer fits the model's context window; use a model with a larger window or narrow the task",
	});
}

export function retryAfterMs(errorMessage: string): number | undefined {
	const match = /retry[- ]after[^0-9]{0,5}(\d+(?:\.\d+)?)/i.exec(errorMessage);
	return match?.[1] ? Math.round(Number(match[1]) * 1000) : undefined;
}

const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/**
 * Backoff before retry `attempt` (1-based, counted per streak of consecutive failures) of a retryable provider error.
 * A rate limit waits `rateLimitBaseDelayMs` (default 5 s) doubling per attempt up to a minute, ±20% so parallel callers
 * spread out; quota windows are seconds to a minute long and providers such as Vertex send no retry-after. Other
 * errors use `retryDelayMs`. A retry-after in the message is always waited at least.
 */
export function providerRetryDelayMs(
	attempt: number,
	errorMessage: string,
	cfg: { retryBaseDelayMs?: number; rateLimitBaseDelayMs?: number },
	random: () => number = Math.random,
): number {
	if (classifyProviderError(errorMessage).code !== "PROVIDER_RATE_LIMIT") return retryDelayMs(attempt, cfg.retryBaseDelayMs ?? 1000, errorMessage, random);
	const base = Math.min(RATE_LIMIT_MAX_DELAY_MS, (cfg.rateLimitBaseDelayMs ?? 5000) * 2 ** (attempt - 1));
	return Math.max(Math.round(base * (0.8 + 0.4 * random())), retryAfterMs(errorMessage) ?? 0);
}

/** Backoff before retry `attempt` (1-based) of a retryable provider error: full jitter on an exponential base, at least the provider's retry-after. */
export function retryDelayMs(attempt: number, baseDelayMs: number, errorMessage: string, random: () => number = Math.random): number {
	return Math.max(random() * baseDelayMs * 2 ** (attempt - 1), retryAfterMs(errorMessage) ?? 0);
}

/** The text the model sees for a failed tool call: code, retryability, message and hint. */
export function toolErrorText(error: NexoError): string {
	return `${error.code}${error.retryable ? " (retryable)" : ""}: ${error.message}${error.hint ? `\nhint: ${error.hint}` : ""}`;
}

/**
 * pi turns an error thrown by a tool into a result holding only `error.message`, so a NexoError is rethrown with its
 * code, retryability and hint in the message.
 */
export function withToolErrorCodes(tool: AgentTool<any, any>): AgentTool<any, any> {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			try {
				return await tool.execute(toolCallId, params, signal, onUpdate);
			} catch (error) {
				if (error instanceof NexoError) throw new Error(toolErrorText(error), { cause: error });
				throw error;
			}
		},
	};
}
