import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { insertRun, listFeedback, openDb } from "@nexo/store";
import { createRedactor } from "@nexo/telemetry";
import { runRow } from "../../store/test/fixtures.ts";
import { errorBody, httpStatusFor, pipeFileRange, startWebServer, type WebServer } from "../src/index.ts";
import { raw } from "./http.ts";

const servers: WebServer[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.close()));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "nexo-web-server-"));
	tempDirs.push(dir);
	return dir;
}

/** A public/ directory inside a temp dir that also holds a file just outside it. */
function publicDir(): string {
	const base = tempDir();
	const dir = join(base, "public");
	mkdirSync(join(dir, "lib"), { recursive: true });
	writeFileSync(join(dir, "index.html"), `<meta name="nexo-token" content="{{NEXO_TOKEN}}"><script type="module" src="/lib/a.ts"></script>`);
	writeFileSync(join(dir, "lib", "a.ts"), `import { type B, c } from "./b.ts";\nexport const x: number = c satisfies B;\n`);
	writeFileSync(join(dir, "lib", "bad.ts"), "enum E { A }\n");
	writeFileSync(join(dir, "style.css"), "body{}");
	writeFileSync(join(dir, "tsconfig.json"), "{}");
	writeFileSync(join(base, "nexo-outside.html"), "outside");
	return dir;
}

async function start(overrides: { token?: string; readOnly?: { message: string; hint: string | null } } = {}) {
	const db = openDb(":memory:");
	const run = runRow({ status: "succeeded" });
	insertRun(db, run);
	const server = await startWebServer({ db, redact: createRedactor(), port: 0, publicDir: publicDir(), ...overrides });
	servers.push(server);
	return { server, db, run };
}

describe("error envelope", () => {
	it("maps codes to statuses and always fills hint and context", () => {
		expect(httpStatusFor("INVALID_REQUEST")).toBe(400);
		expect(httpStatusFor("FORBIDDEN")).toBe(403);
		expect(httpStatusFor("NOT_FOUND")).toBe(404);
		expect(httpStatusFor("METHOD_NOT_ALLOWED")).toBe(405);
		expect(httpStatusFor("CONFLICT")).toBe(409);
		expect(httpStatusFor("STORE_IO")).toBe(500);
		expect(errorBody(new Error("boom"))).toEqual({
			status: 500,
			body: { error: { code: "INTERNAL", message: "boom", retryable: false, hint: null, context: {} } },
		});
	});
});

describe("startWebServer", () => {
	it("binds to 127.0.0.1 with a random token per launch", async () => {
		const a = await start();
		const b = await start();
		expect(a.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
		expect(a.server.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(a.server.token).not.toBe(b.server.token);
		await expect(startWebServer({ db: a.db, redact: createRedactor(), host: "0.0.0.0" as "127.0.0.1" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
	});

	it("reports a busy port as CONFIG_INVALID with a hint", async () => {
		const { server, db } = await start();
		await expect(startWebServer({ db, redact: createRedactor(), port: server.port })).rejects.toMatchObject({ code: "CONFIG_INVALID", hint: expect.stringContaining("--port") });
	});

	it("embeds the token in served HTML with a strict CSP", async () => {
		const { server } = await start();
		const res = await raw(server.port, "/");
		expect(res.status).toBe(200);
		expect(res.text).toContain(`content="${server.token}"`);
		expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
		expect(res.headers["x-content-type-options"]).toBe("nosniff");
	});

	it("serves browser TypeScript as type-stripped JavaScript", async () => {
		const { server } = await start();
		const res = await raw(server.port, "/lib/a.ts");
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
		expect(res.text).toMatch(/^import \{\s+c \} from "\.\/b\.ts";/);
		expect(res.text).not.toMatch(/: number|satisfies/);
	});

	it("drops only the stripTypeScriptTypes warning, in a fresh process where it is emitted for the first time", () => {
		const strip = pathToFileURL(join(import.meta.dirname, "..", "src", "strip.ts")).href;
		const script = [
			`import { stripBrowserTypeScript } from ${JSON.stringify(strip)};`,
			`const original = process.emitWarning;`,
			`console.log(stripBrowserTypeScript("let a: string = 'x';", "/a.ts"));`,
			`console.log(process.emitWarning === original ? "restored" : "replaced");`,
			`process.emitWarning("another warning");`,
		].join("\n");
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout).toContain("let a         = 'x';");
		expect(child.stdout).toContain("restored");
		expect(child.stderr).not.toContain("stripTypeScriptTypes");
		expect(child.stderr).toContain("another warning");
	});

	it("returns a structured 500 for non-erasable browser TypeScript", async () => {
		const { server } = await start();
		const res = await raw(server.port, "/lib/bad.ts");
		expect(res.status).toBe(500);
		expect(res.json().error.code).toBe("INTERNAL");
	});

	it("404s files outside public/, unknown extensions and unknown API routes", async () => {
		const { server } = await start();
		for (const path of ["/tsconfig.json", "/../nexo-outside.html", "/%2e%2e/nexo-outside.html", "/missing.html", "/%E0%A4%A.html", "/api/nope"]) {
			const res = await raw(server.port, path);
			expect(res.status, path).toBe(404);
			expect(res.json().error).toMatchObject({ code: "NOT_FOUND", retryable: false });
		}
	});

	it("refuses requests whose Host header is not the loopback address", async () => {
		const { server } = await start();
		const res = await raw(server.port, "/", { headers: { host: "evil.example:80" } });
		expect(res.status).toBe(403);
		expect(res.json().error.code).toBe("FORBIDDEN");
		expect((await raw(server.port, "/", { headers: { host: `localhost:${server.port}` } })).status).toBe(200);
	});

	it("requires the token on mutating requests and answers 405 for wrong methods", async () => {
		const { server, run } = await start();
		const body = JSON.stringify({ verdict: "done" });
		const json = { "content-type": "application/json" };
		const missing = await raw(server.port, `/api/runs/${run.id}/feedback`, { method: "POST", headers: json, body });
		expect(missing.status).toBe(403);
		expect(missing.json().error).toMatchObject({ code: "FORBIDDEN", hint: expect.stringContaining("x-nexo-token") });
		expect(missing.json().error.hint).toMatch(/previous|reload/);
		const wrong = await raw(server.port, `/api/runs/${run.id}/feedback`, { method: "POST", headers: { ...json, "x-nexo-token": "x".repeat(32) }, body });
		expect(wrong.status).toBe(403);
		const ok = await raw(server.port, `/api/runs/${run.id}/feedback`, { method: "POST", headers: { ...json, "x-nexo-token": server.token }, body });
		expect(ok.status).toBe(201);
		const getFeedback = await raw(server.port, `/api/runs/${run.id}/feedback`);
		expect(getFeedback.status).toBe(405);
		const deleteRuns = await raw(server.port, "/api/runs", { method: "DELETE", headers: { "x-nexo-token": server.token } });
		expect(deleteRuns.status).toBe(405);
	});

	it("rejects non-JSON, malformed and oversized bodies", async () => {
		const { server, db, run } = await start();
		const path = `/api/runs/${run.id}/feedback`;
		const headers = { "x-nexo-token": server.token, "content-type": "application/json" };
		expect((await raw(server.port, path, { method: "POST", headers: { "x-nexo-token": server.token, "content-type": "text/plain" }, body: "{}" })).status).toBe(400);
		expect((await raw(server.port, path, { method: "POST", headers, body: "{nope" })).json().error.code).toBe("INVALID_REQUEST");
		const oversized = await raw(server.port, path, { method: "POST", headers, body: JSON.stringify({ verdict: "done", comment: "short", padding: "x".repeat(70_000) }) });
		expect(oversized.status).toBe(400);
		expect(oversized.json().error.message).toContain("larger than 65536 bytes");
		expect((await raw(server.port, path, { method: "POST", headers, body: "[1]" })).status).toBe(400);
		expect(listFeedback(db, run.id)).toEqual([]);
	});

	it("refuses writes with CONFIG_INVALID in read-only mode and reports the mode in /api/meta", async () => {
		const { server, db, run } = await start({ readOnly: { message: "the nexo config is missing or invalid", hint: "Fix ~/.nexo/config.json" } });
		const res = await raw(server.port, `/api/runs/${run.id}/feedback`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-nexo-token": server.token },
			body: JSON.stringify({ verdict: "done", comment: "kept out of the store" }),
		});
		expect(res.status).toBe(400);
		expect(res.json().error).toMatchObject({ code: "CONFIG_INVALID", message: "The UI is read-only: the nexo config is missing or invalid", hint: "Fix ~/.nexo/config.json" });
		expect(listFeedback(db, run.id)).toEqual([]);
		const meta = (await raw(server.port, "/api/meta")).json();
		expect(meta.readOnly).toEqual({ message: "the nexo config is missing or invalid", hint: "Fix ~/.nexo/config.json" });
		expect(meta.runStatuses).toContain("budget_exceeded");
		expect(meta.costDimensions).toContain("tier");
	});

	it("stops accepting connections after close", async () => {
		const { server } = await start();
		await server.close();
		servers.splice(servers.indexOf(server), 1);
		await expect(raw(server.port, "/")).rejects.toThrow();
	});
});

describe("pipeFileRange", () => {
	async function serveRange(file: string, length: number, before: () => void = () => {}): Promise<Server> {
		const server = createServer((_req, res) => {
			const fd = openSync(file, "r");
			res.writeHead(200, { "content-type": "text/plain", "content-length": length });
			before();
			pipeFileRange(res, fd, length);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		return server;
	}

	it("streams exactly the requested bytes of a file that keeps growing", async () => {
		const file = join(tempDir(), "grow.txt");
		writeFileSync(file, "a".repeat(10));
		const server = await serveRange(file, 10, () => writeFileSync(file, "b".repeat(100), { flag: "a" }));
		const res = await raw((server.address() as AddressInfo).port, "/");
		server.close();
		expect(res.text).toBe("a".repeat(10));
	});

	it("destroys the connection instead of hanging when the file is shorter than the promised length", async () => {
		const file = join(tempDir(), "short.txt");
		writeFileSync(file, "x".repeat(10));
		const server = await serveRange(file, 100);
		await expect(raw((server.address() as AddressInfo).port, "/")).rejects.toThrow();
		server.close();
	});

	it("destroys the connection on a read error", async () => {
		const dir = tempDir();
		const server = await serveRange(dir, 100);
		await expect(raw((server.address() as AddressInfo).port, "/")).rejects.toThrow();
		server.close();
	});
});
