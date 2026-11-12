import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedactor } from "@nexo/telemetry";
import type { HomeResponse } from "../src/home-api.ts";
import { startWebServer, type WebServer } from "../src/index.ts";
import { buildFixture, type Fixture } from "./fixtures.ts";
import { raw } from "./http.ts";

let fx: Fixture;
let server: WebServer;

beforeAll(async () => {
	fx = buildFixture();
	const wikis = join(fx.home, "wikis");
	mkdirSync(join(wikis, "builds", "nexo", "concepts"), { recursive: true });
	writeFileSync(join(wikis, "builds", "nexo", "overview.html"), '<!doctype html><html><head><meta name="summary" content="The nexo harness"></head><body></body></html>');
	writeFileSync(join(wikis, "builds", "nexo", "concepts", "a.html"), "<!doctype html><html></html>");
	const area = (id: string, status: string, w: string[]) => ({ id, name: id, scope: `${id} scope`, examples: [], aliases: [], wikis: w, status, createdAt: "2026-11-11" });
	writeFileSync(join(wikis, "areas.json"), JSON.stringify({ version: 1, areas: [area("builds", "active", ["nexo", "missing"]), area("travel", "proposed", [])], unsorted: [{ label: "travel" }] }));
	const lines = [
		JSON.stringify({ at: "2026-10-01T00:00:00.000Z", text: "Old work", areaId: "builds", wiki: "nexo", sessionId: null, runId: "r1", verified: true }),
		"not json",
		JSON.stringify({ at: "2026-11-10T00:00:00.000Z", text: "Fixed the build", areaId: "builds", wiki: "nexo", sessionId: "s1", runId: "r2", verified: false }),
	];
	writeFileSync(join(wikis, "feed.jsonl"), `${lines.join("\n")}\n`);
	writeFileSync(join(wikis, "decisions.jsonl"), `${JSON.stringify({ at: "2026-11-10T00:00:00.000Z", choice: "HTML pages", reason: "readable", areaId: "builds", wiki: "nexo", sessionId: "s1", runId: "r2" })}\n`);
	server = await startWebServer({ db: fx.db, redact: createRedactor(), port: 0, wikisDir: wikis, now: () => new Date("2026-11-11T00:00:00.000Z") });
});

afterAll(async () => {
	await server.close();
	fx.db.close();
	rmSync(fx.home, { recursive: true, force: true });
});

describe("home API", () => {
	it("returns active areas with existing wikis, the feed newest first, decisions and proposals", async () => {
		const res = await raw(server.port, "/api/home");
		expect(res.status).toBe(200);
		const d = res.json() as HomeResponse;
		expect(d.areas.map((a) => a.id)).toEqual(["builds"]);
		expect(d.areas[0]?.wikis).toEqual([{ name: "nexo", summary: "The nexo harness", pageCount: 2, path: "builds/nexo" }]);
		expect(d.areas[0]?.recent).toBe(1);
		expect(d.feed.map((f) => f.text)).toEqual(["Fixed the build", "Old work"]);
		expect(d.decisions[0]?.choice).toBe("HTML pages");
		expect(d.proposed).toEqual([{ id: "travel", name: "travel" }]);
		expect(d.unsorted).toBe(1);
	});

	it("lists a folder's pages and serves one page, refusing paths outside the home", async () => {
		const f = await raw(server.port, "/api/home/folder?area=builds&name=nexo");
		expect(f.status).toBe(200);
		expect((f.json() as { pages: { path: string }[] }).pages.map((p) => p.path)).toEqual(["builds/nexo/concepts/a.html", "builds/nexo/overview.html"]);
		const p = await raw(server.port, "/api/home/page?path=builds/nexo/overview.html");
		expect(p.status).toBe(200);
		expect((p.json() as { summary?: string }).summary).toBe("The nexo harness");
		for (const bad of ["../../etc/x.html", "areas.json", "builds/nexo/../../x.html", "builds/x.html"]) expect((await raw(server.port, `/api/home/page?path=${encodeURIComponent(bad)}`)).status, bad).not.toBe(200);
		expect((await raw(server.port, "/api/home/folder?area=..&name=nexo")).status).not.toBe(200);
	});

	it("serves the home page", async () => {
		const res = await raw(server.port, "/home.html");
		expect(res.status).toBe(200);
		expect(res.text).toContain("/pages/home.ts");
	});
});
