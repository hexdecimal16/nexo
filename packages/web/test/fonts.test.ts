import { statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { startWebServer, type WebServer } from "../src/index.ts";
import { raw } from "./http.ts";

let server: WebServer;
beforeAll(async () => {
	server = await startWebServer({ db: openDb(":memory:"), redact: createRedactor(), port: 0 });
});
afterAll(async () => {
	await server.close();
});

const FONTS = ["GeistMono-400.woff2", "GeistMono-600.woff2", "InstrumentSans-400.woff2", "InstrumentSans-600.woff2"];

describe("fonts", () => {
	it("serve every font the stylesheet declares, as font/woff2 with the file's length", async () => {
		const css = (await raw(server.port, "/style.css")).text;
		for (const name of FONTS) {
			expect(css, name).toContain(`/fonts/${name}`);
			const res = await raw(server.port, `/fonts/${name}`);
			expect(res.status, name).toBe(200);
			expect(res.headers["content-type"], name).toBe("font/woff2");
			expect(Number(res.headers["content-length"]), name).toBe(statSync(new URL(`../public/fonts/${name}`, import.meta.url)).size);
		}
	});

	it("allow fonts from the same origin in the page CSP and keep everything else closed", async () => {
		const csp = String((await raw(server.port, "/")).headers["content-security-policy"]);
		expect(csp).toContain("font-src 'self';");
		expect(csp).toContain("default-src 'none'");
		expect(csp).not.toMatch(/https?:|unsafe-inline/);
	});

	it("keep path confinement for fonts", async () => {
		expect((await raw(server.port, "/fonts/../../src/static.ts")).status).toBe(404);
		expect((await raw(server.port, "/fonts/missing.woff2")).status).toBe(404);
	});
});
