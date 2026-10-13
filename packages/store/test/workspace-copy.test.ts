import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRedactor, type NexoError } from "@nexo/telemetry";
import { copyWorkspaceTree, RunDir } from "../src/index.ts";

const redact = createRedactor();

/** A workspace with a nested file, a relative, an absolute and a dangling symlink. */
function sourceTree(): { src: string; outside: string } {
	const root = mkdtempSync(join(tmpdir(), "nexo-wscopy-"));
	const src = join(root, "src");
	mkdirSync(join(src, "nested", "deeper"), { recursive: true });
	writeFileSync(join(src, "a.txt"), "aaaa");
	writeFileSync(join(src, "nested", "deeper", "b.bin"), "bbbbbb");
	const outside = join(root, "outside.txt");
	writeFileSync(outside, "outside");
	symlinkSync("a.txt", join(src, "rel-link"));
	symlinkSync(outside, join(src, "abs-link"));
	symlinkSync("missing-target", join(src, "dangling"));
	return { src, outside };
}

function emptyDest(): string {
	return mkdtempSync(join(tmpdir(), "nexo-wscopy-dest-"));
}

function expectCopied(src: string, dest: string, outside: string): void {
	expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("aaaa");
	expect(readFileSync(join(dest, "nested", "deeper", "b.bin"), "utf8")).toBe("bbbbbb");
	for (const [name, target] of [
		["rel-link", "a.txt"],
		["abs-link", outside],
		["dangling", "missing-target"],
	] as const) {
		expect(lstatSync(join(dest, name)).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(dest, name))).toBe(target);
	}
	expect(readdirSync(src).sort()).toEqual(readdirSync(dest).sort());
}

/** A copyFile that records the mode it was given and copies for real. */
function recordingCopyFile(modes: number[]) {
	return async (from: string, to: string, mode: number) => {
		modes.push(mode);
		copyFileSync(from, to);
	};
}

describe("copyWorkspaceTree", () => {
	it("off macOS, copies the tree itself, asking for a copy-on-write clone of every file, and keeps symlinks verbatim", async () => {
		const { src, outside } = sourceTree();
		const dest = emptyDest();
		const modes: number[] = [];
		const cpCalls: string[][] = [];
		const bytes = await copyWorkspaceTree(src, dest, {
			platform: "linux",
			copyFile: recordingCopyFile(modes),
			runCp: async (args) => {
				cpCalls.push(args);
			},
		});
		expect(cpCalls).toEqual([]);
		expect(modes).toEqual([constants.COPYFILE_FICLONE, constants.COPYFILE_FICLONE]);
		expect(bytes).toBe(10);
		expectCopied(src, dest, outside);
	});

	it("with the default copyFile, copies for real", async () => {
		const { src, outside } = sourceTree();
		const dest = emptyDest();
		expect(await copyWorkspaceTree(src, dest, { platform: "linux" })).toBe(10);
		expectCopied(src, dest, outside);
	});

	it("on macOS, clones with cp -cRP of the source's contents into the destination", async () => {
		const { src } = sourceTree();
		const dest = emptyDest();
		const cpCalls: string[][] = [];
		const modes: number[] = [];
		const bytes = await copyWorkspaceTree(src, dest, {
			platform: "darwin",
			copyFile: recordingCopyFile(modes),
			runCp: async (args) => {
				cpCalls.push(args);
				writeFileSync(join(dest, "cloned.txt"), "123");
			},
		});
		expect(cpCalls).toEqual([["-cRP", `${src}/.`, dest]]);
		expect(modes).toEqual([]);
		expect(bytes).toBe(3);
	});

	it.runIf(process.platform === "darwin")("on macOS, the real cp copies files and keeps symlinks verbatim", async () => {
		const { src, outside } = sourceTree();
		const dest = emptyDest();
		expect(await copyWorkspaceTree(src, dest)).toBe(10);
		expectCopied(src, dest, outside);
	});

	it("on macOS, falls back to the JS copy when cp fails, after removing what cp left", async () => {
		const { src, outside } = sourceTree();
		const dest = emptyDest();
		const modes: number[] = [];
		const bytes = await copyWorkspaceTree(src, dest, {
			platform: "darwin",
			copyFile: recordingCopyFile(modes),
			runCp: async () => {
				writeFileSync(join(dest, "partial.txt"), "half");
				throw new Error("cp: clonefile failed: Operation not supported");
			},
		});
		expect(modes).toHaveLength(2);
		expect(bytes).toBe(10);
		expect(existsSync(join(dest, "partial.txt"))).toBe(false);
		expectCopied(src, dest, outside);
	});

	it("stops on abort without falling back", async () => {
		const { src } = sourceTree();
		const dest = emptyDest();
		const ac = new AbortController();
		const modes: number[] = [];
		const copy = copyWorkspaceTree(src, dest, {
			platform: "darwin",
			signal: ac.signal,
			copyFile: recordingCopyFile(modes),
			runCp: (_args, signal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});
		ac.abort();
		await expect(copy).rejects.toThrow();
		expect(modes).toEqual([]);
	});

	it("checks the signal between files in the JS copy", async () => {
		const { src } = sourceTree();
		const dest = emptyDest();
		const ac = new AbortController();
		const modes: number[] = [];
		await expect(
			copyWorkspaceTree(src, dest, {
				platform: "linux",
				signal: ac.signal,
				copyFile: async (from, to, mode) => {
					await recordingCopyFile(modes)(from, to, mode);
					ac.abort();
				},
			}),
		).rejects.toThrow();
		expect(modes).toHaveLength(1);
	});
});

describe("RunDir.copyIntoWorkspace", () => {
	it("records the copied bytes", async () => {
		const { src } = sourceTree();
		const dir = RunDir.create(mkdtempSync(join(tmpdir(), "nexo-runs-")), "r2", redact);
		expect(await dir.copyIntoWorkspace({ runId: "r1", dir: src }, { platform: "linux" })).toBe(10);
		expect(readFileSync(join(dir.workspaceDir, "a.txt"), "utf8")).toBe("aaaa");
	});

	it("fails with STORE_IO naming the source run and folder, and leaves the workspace empty", async () => {
		const { src } = sourceTree();
		const dir = RunDir.create(mkdtempSync(join(tmpdir(), "nexo-runs-")), "r2", redact);
		let calls = 0;
		const error = (await dir
			.copyIntoWorkspace(
				{ runId: "r1", dir: src },
				{
					platform: "linux",
					copyFile: async (from, to) => {
						if (++calls === 2) throw new Error("EIO: disk error");
						copyFileSync(from, to);
					},
				},
			)
			.catch((e: unknown) => e)) as NexoError;
		expect(error.code).toBe("STORE_IO");
		expect(error.message).toContain("r1");
		expect(error.message).toContain(src);
		expect(error.hint).toContain(src);
		expect(existsSync(dir.workspaceDir)).toBe(true);
		expect(readdirSync(dir.workspaceDir)).toEqual([]);
	});

	it("reports an abort as such and leaves the workspace empty", async () => {
		const { src } = sourceTree();
		const dir = RunDir.create(mkdtempSync(join(tmpdir(), "nexo-runs-")), "r2", redact);
		const ac = new AbortController();
		const error = (await dir
			.copyIntoWorkspace(
				{ runId: "r1", dir: src },
				{
					platform: "linux",
					signal: ac.signal,
					copyFile: async (from, to) => {
						copyFileSync(from, to);
						ac.abort();
					},
				},
			)
			.catch((e: unknown) => e)) as NexoError;
		expect(error.code).not.toBe("STORE_IO");
		expect(error.message).toMatch(/aborted/);
		expect(readdirSync(dir.workspaceDir)).toEqual([]);
	});
});
