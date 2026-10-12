import { spawnSync } from "node:child_process";
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

const PAGES = ["/", "/run.html", "/cost.html", "/judge.html", "/learning.html"];

/** Every browser module reachable from the pages, following static `from "./x.ts"` imports. */
async function reachableModules(): Promise<Map<string, string>> {
	const modules = new Map<string, string>();
	const queue: string[] = [];
	for (const page of PAGES) {
		const res = await raw(server.port, page);
		for (const m of res.text.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)) queue.push(m[1] as string);
	}
	while (queue.length) {
		const path = queue.shift() as string;
		if (modules.has(path)) continue;
		const res = await raw(server.port, path);
		expect(res.status, path).toBe(200);
		expect(res.headers["content-type"], path).toBe("text/javascript; charset=utf-8");
		modules.set(path, res.text);
		for (const m of res.text.matchAll(/from "(\.{1,2}\/[^"]+\.ts)"/g)) queue.push(new URL(m[1] as string, `http://x${path}`).pathname);
	}
	return modules;
}

describe("pages", () => {
	it("serve each page with the token, the stylesheet and no inline script or style", async () => {
		for (const page of PAGES) {
			const res = await raw(server.port, page);
			expect(res.status, page).toBe(200);
			expect(res.text, page).toContain(`<meta name="nexo-token" content="${server.token}">`);
			expect(res.text, page).toContain(`<link rel="stylesheet" href="/style.css">`);
			expect(res.text, page).not.toMatch(/<script(?![^>]*\ssrc=)/);
			expect(res.text, page).not.toMatch(/\sstyle=|\son[a-z]+=/);
		}
		expect((await raw(server.port, "/style.css")).headers["content-type"]).toBe("text/css; charset=utf-8");
	});

	it("serve browser modules that parse as JavaScript", async () => {
		const modules = await reachableModules();
		expect([...modules.keys()].sort()).toEqual(
			expect.arrayContaining(["/lib/html.ts", "/lib/judge-view.ts", "/lib/learning-view.ts", "/lib/poller.ts", "/lib/run-view.ts", "/lib/score-view.ts", "/lib/span-view.ts", "/lib/timeline.ts", "/pages/api.ts", "/pages/cost.ts", "/pages/judge.ts", "/pages/learning.ts", "/pages/run.ts", "/pages/runs.ts"]),
		);
		for (const [path, code] of modules) {
			const check = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: code, encoding: "utf8" });
			expect(check.status, `${path}: ${check.stderr}`).toBe(0);
		}
	});
});
