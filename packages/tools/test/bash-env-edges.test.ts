import { describe, expect, it } from "vitest";
import { bashEnv } from "../src/index.ts";

const kept = (name: string) => name in bashEnv({ [name]: "v" });

describe("bashEnv edge cases", () => {
	it.each(["github_token", "Api_Key", "APIKEY", "TOKEN", "STRIPE_SECRET_KEY", "GH_TOKEN", "SLACK_BOT_TOKEN", "MY_SESSION_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_SECRET"])("removes %s", (name) => {
		expect(kept(name)).toBe(false);
	});

	it.each(["AWS_PROFILE", "AWS_REGION", "GOOGLE_CLOUD_PROJECT", "KEY", "KEYCHAIN", "TOKENS_PER_MIN", "SECRETARY", "NODE_OPTIONS", "SSH_CONNECTION"])("keeps %s", (name) => {
		expect(kept(name)).toBe(true);
	});

	it("keeps empty values and values containing = and newlines", () => {
		expect(bashEnv({ EMPTY: "", EQ: "a=b=c", NL: "x\ny" })).toEqual({ EMPTY: "", EQ: "a=b=c", NL: "x\ny" });
	});

	it("does not inspect values: a secret inside an ordinary variable passes through (known limit)", () => {
		expect(bashEnv({ DATABASE_URL: "postgres://u:hunter2@h/db" }).DATABASE_URL).toContain("hunter2");
	});
});
