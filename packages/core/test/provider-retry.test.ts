import { describe, expect, it } from "vitest";
import { isRetryableProviderMessage, providerRetryDelayMs, withinRetryLimits } from "../src/engine/errors.ts";

const failed = (errorMessage: string) => ({ stopReason: "error", errorMessage }) as never;

describe("provider retry policy", () => {
	it("retries kiro-cli high-traffic and stall errors but not quota or auth errors", () => {
		expect(isRetryableProviderMessage(failed("kiro-cli failed: Claude Opus 5.5 is experiencing high traffic. Try again, or select another model. (Request ID: 0b5ae781)"))).toBe(true);
		expect(isRetryableProviderMessage(failed("kiro-cli failed: no output for 120s"))).toBe(true);
		expect(isRetryableProviderMessage(failed("503 Service Unavailable"))).toBe(true);
		expect(isRetryableProviderMessage(failed("quota exceeded, try again tomorrow"))).toBe(false);
		expect(isRetryableProviderMessage(failed("invalid api key"))).toBe(false);
	});

	it("caps a single backoff at a minute", () => {
		expect(providerRetryDelayMs(30, "503 Service Unavailable", {}, () => 0.999)).toBeLessThanOrEqual(60_000);
	});

	it("honours an explicit maxRetries as a count", () => {
		expect(withinRetryLimits(3, 10 ** 9, { maxRetries: 3 })).toBe(true);
		expect(withinRetryLimits(4, 0, { maxRetries: 3 })).toBe(false);
	});

	it("keeps retrying with exponential backoff for 30 minutes when maxRetries is unset", () => {
		let waited = 0;
		let attempt = 0;
		for (;;) {
			attempt++;
			const delay = providerRetryDelayMs(attempt, "kiro-cli failed: no output for 120s", {}, () => 0.5);
			if (!withinRetryLimits(attempt, waited + delay, {})) break;
			waited += delay;
		}
		expect(waited).toBeGreaterThan(29 * 60_000);
		expect(waited).toBeLessThanOrEqual(30 * 60_000);
		expect(withinRetryLimits(2, 5 * 60_000, { retryWindowMs: 60_000 })).toBe(false);
	});
});
