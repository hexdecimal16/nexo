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
	if (/\b429\b|rate.?limit|too many requests/.test(lower)) {
		return new NexoError({ code: "PROVIDER_RATE_LIMIT", message, retryable: true, hint: "Lower providers.<name>.maxConcurrent or retry later" });
	}
	if (/timed? ?out|timeout|etimedout/.test(lower)) {
		return new NexoError({ code: "PROVIDER_TIMEOUT", message, retryable: true, hint: "Retry the run; check network connectivity" });
	}
	return new NexoError({ code: "PROVIDER_UNAVAILABLE", message, retryable: true, hint: "The provider returned an error; retry later" });
}

export function retryAfterMs(errorMessage: string): number | undefined {
	const match = /retry[- ]after[^0-9]{0,5}(\d+(?:\.\d+)?)/i.exec(errorMessage);
	return match?.[1] ? Math.round(Number(match[1]) * 1000) : undefined;
}
