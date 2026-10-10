import { describe, expect, it } from "vitest";
import { NexoError, toErrorPayload } from "../src/index.ts";

describe("NexoError", () => {
	it("carries code, retryable, hint and context", () => {
		const err = new NexoError({
			code: "BUDGET_EXCEEDED",
			message: "Run budget exhausted",
			hint: "Raise budgets.perRunUsd",
			context: { limitUsd: 0.5 },
		});
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("NexoError");
		expect(err.retryable).toBe(false);
		expect(err.toPayload()).toEqual({
			code: "BUDGET_EXCEEDED",
			message: "Run budget exhausted",
			retryable: false,
			hint: "Raise budgets.perRunUsd",
			context: { limitUsd: 0.5 },
		});
	});

	it("keeps the cause", () => {
		const cause = new Error("disk full");
		const err = new NexoError({ code: "STORE_IO", message: "write failed", cause });
		expect(err.cause).toBe(cause);
	});
});

describe("toErrorPayload", () => {
	it("maps NexoError to its payload", () => {
		const err = new NexoError({ code: "TOOL_DENIED", message: "no", retryable: false });
		expect(toErrorPayload(err).code).toBe("TOOL_DENIED");
	});

	it("maps unknown errors to INTERNAL", () => {
		expect(toErrorPayload(new Error("boom"))).toEqual({ code: "INTERNAL", message: "boom", retryable: false });
		expect(toErrorPayload("weird")).toEqual({ code: "INTERNAL", message: "weird", retryable: false });
		expect(toErrorPayload(null)).toEqual({ code: "INTERNAL", message: "Unknown error", retryable: false });
	});
});
