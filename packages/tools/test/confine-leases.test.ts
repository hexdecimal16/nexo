import { mkdirSync, writeFileSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NexoError } from "@nexo/telemetry";
import { FileLeases, resolveConfined } from "../src/index.ts";

describe("resolveConfined", () => {
	const root = mkdtempSync(join(tmpdir(), "nexo-ws-"));
	const real = realpathSync(root);

	it("resolves relative and not-yet-existing nested paths inside the root", () => {
		expect(resolveConfined(root, "a/b/c.txt")).toBe(join(real, "a/b/c.txt"));
		expect(resolveConfined(root, join(root, "x.txt"))).toBe(join(real, "x.txt"));
	});

	it.each(["../outside.txt", "/etc/passwd"])("denies %s", (target) => {
		try {
			resolveConfined(root, target);
			expect.unreachable();
		} catch (err) {
			expect((err as NexoError).code).toBe("TOOL_DENIED");
		}
	});

	it("denies symlinks that escape the root", () => {
		const outside = mkdtempSync(join(tmpdir(), "nexo-out-"));
		mkdirSync(join(root, "inner"), { recursive: true });
		symlinkSync(outside, join(root, "inner", "link"));
		expect(() => resolveConfined(root, "inner/link/file.txt")).toThrow(/outside the workspace/);
	});

	it("denies a final-component symlink pointing outside", () => {
		const outside = mkdtempSync(join(tmpdir(), "nexo-out-"));
		writeFileSync(join(outside, "f.txt"), "x");
		symlinkSync(join(outside, "f.txt"), join(root, "filelink"));
		expect(() => resolveConfined(root, "filelink")).toThrow(/outside the workspace/);
	});

	it("denies dangling symlinks pointing outside (file and directory)", () => {
		const outside = mkdtempSync(join(tmpdir(), "nexo-out-"));
		symlinkSync(join(outside, "pwned.txt"), join(root, "dangling"));
		symlinkSync(join(outside, "newdir"), join(root, "dangdir"));
		for (const target of ["dangling", "dangdir/f.txt"]) {
			try {
				resolveConfined(root, target);
				expect.unreachable();
			} catch (err) {
				expect((err as NexoError).code).toBe("TOOL_DENIED");
			}
		}
	});
});

describe("FileLeases", () => {
	it("allows the same holder, rejects others with retryable WRITE_CONFLICT, and releases", () => {
		const leases = new FileLeases();
		leases.acquire("/w/a.txt", "run-1");
		leases.acquire("/w/a.txt", "run-1");
		try {
			leases.acquire("/w/a.txt", "run-2");
			expect.unreachable();
		} catch (err) {
			expect((err as NexoError).code).toBe("WRITE_CONFLICT");
			expect((err as NexoError).retryable).toBe(true);
		}
		leases.releaseAll("run-1");
		expect(leases.holderOf("/w/a.txt")).toBeUndefined();
		leases.acquire("/w/a.txt", "run-2");
	});

	it("treats the raw and realpath spellings of a file as one lease", () => {
		const ws = mkdtempSync(join(tmpdir(), "nexo-ws-"));
		const leases = new FileLeases();
		leases.acquire(join(realpathSync(ws), "a.txt"), "run-1");
		expect(leases.holderOf(join(ws, "a.txt"))).toBe("run-1");
	});
});
