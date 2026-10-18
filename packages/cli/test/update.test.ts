import { describe, expect, it } from "vitest";
import type { CliIO } from "../src/common.ts";
import { compareVersions, type FetchLike, updateCommand } from "../src/update.ts";

function io(): CliIO & { out: () => string } {
	let out = "";
	return {
		stdout: { write: (s: string) => ((out += s), true) },
		stderr: { write: () => true },
		out: () => out,
	};
}

const reply = (version: unknown, ok = true, status = 200): FetchLike => async () => ({ ok, status, json: async () => ({ version }) });

describe("compareVersions", () => {
	it("orders x.y.z versions numerically", () => {
		expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
	});

	it("returns null for anything but x.y.z", () => {
		expect(compareVersions("unknown", "1.0.0")).toBeNull();
		expect(compareVersions("1.0.0-beta", "1.0.0")).toBeNull();
	});
});

describe("nexo update", () => {
	it("prints the install command when a newer version exists", async () => {
		const t = io();
		expect(await updateCommand(t, { current: "0.2.0", name: "@hexdecimal16/nexo", fetch: reply("0.3.0") })).toBe(0);
		expect(t.out()).toContain("Update available: 0.2.0 -> 0.3.0");
		expect(t.out()).toContain("npm install -g @hexdecimal16/nexo@latest");
	});

	it("says it is up to date when the versions match", async () => {
		const t = io();
		expect(await updateCommand(t, { current: "0.2.1", name: "@hexdecimal16/nexo", fetch: reply("0.2.1") })).toBe(0);
		expect(t.out()).toContain("up to date");
	});

	it("asks the scoped package URL with an encoded slash", async () => {
		let url = "";
		const fetch: FetchLike = async (u) => ((url = u), { ok: true, status: 200, json: async () => ({ version: "0.2.1" }) });
		await updateCommand(io(), { current: "0.2.1", name: "@hexdecimal16/nexo", fetch });
		expect(url).toBe("https://registry.npmjs.org/@hexdecimal16%2fnexo/latest");
	});

	it("fails with PROVIDER_UNAVAILABLE when the registry cannot be reached", async () => {
		const fetch: FetchLike = async () => {
			throw new Error("offline");
		};
		await expect(updateCommand(io(), { current: "0.2.0", name: "x", fetch })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
	});

	it("fails on an HTTP error or a reply without a version", async () => {
		await expect(updateCommand(io(), { current: "0.2.0", name: "x", fetch: reply(undefined, false, 404) })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
		await expect(updateCommand(io(), { current: "0.2.0", name: "x", fetch: reply(42) })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
	});
});
