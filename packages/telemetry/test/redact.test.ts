import { describe, expect, it } from "vitest";
import { createRedactor, NexoError, REDACTED } from "../src/index.ts";

describe("createRedactor", () => {
	const redact = createRedactor();

	it("redacts built-in secret patterns inside strings", () => {
		const out = redact("key sk-ant-api03-abcdefghijklmnopqrstuvwx and AKIAABCDEFGHIJKLMNOP");
		expect(out).toBe(`key ${REDACTED} and ${REDACTED}`);
	});

	it("redacts values of sensitive keys at any depth", () => {
		const out = redact({ headers: { Authorization: "Bearer abc", "x-api-key": "k" }, apiKey: "v", tokensIn: 5 });
		expect(out).toEqual({ headers: { Authorization: REDACTED, "x-api-key": REDACTED }, apiKey: REDACTED, tokensIn: 5 });
	});

	it("does not mutate its input", () => {
		const input = { apiKey: "secret" };
		redact(input);
		expect(input.apiKey).toBe("secret");
	});

	it("applies extra patterns", () => {
		const custom = createRedactor(["acct-[0-9]{6}"]);
		expect(custom("id acct-123456")).toBe(`id ${REDACTED}`);
	});

	it("handles circular references", () => {
		const a: Record<string, unknown> = { name: "a" };
		a.self = a;
		expect(redact(a)).toEqual({ name: "a", self: "[Circular]" });
	});

	it("keeps shared references that are not circular", () => {
		const shared = { v: 1 };
		expect(redact({ a: shared, b: shared, list: [shared, shared] })).toEqual({
			a: { v: 1 },
			b: { v: 1 },
			list: [{ v: 1 }, { v: 1 }],
		});
	});

	it("rejects invalid extra patterns with CONFIG_INVALID", () => {
		try {
			createRedactor(["(unclosed"]);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(NexoError);
			expect((err as NexoError).code).toBe("CONFIG_INVALID");
		}
	});
});
