import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

export interface WorkspaceCopyOptions {
	/** Stops the copy; the promise then rejects and nothing falls back. */
	signal?: AbortSignal;
	/** Defaults to `process.platform`. */
	platform?: NodeJS.Platform;
	/** Runs `/bin/cp` with these arguments (macOS only). */
	runCp?: (args: string[], signal?: AbortSignal) => Promise<void>;
	/** Copies one regular file with the given `fs.copyFile` mode. */
	copyFile?: (from: string, to: string, mode: number) => Promise<void>;
}

function defaultRunCp(args: string[], signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("/bin/cp", args, { signal }, (error, _stdout, stderr) => {
			if (error) reject(stderr ? new Error(`${error.message}: ${String(stderr).trim()}`, { cause: error }) : error);
			else resolve();
		});
	});
}

/** Removes everything inside `dir`, keeping `dir`. */
export async function emptyDir(dir: string): Promise<void> {
	for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
}

/** Total size of the regular files under `dir`, not following symlinks. */
async function regularFileBytes(dir: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) total += await regularFileBytes(path);
		else if (entry.isFile()) total += (await lstat(path)).size;
	}
	return total;
}

/**
 * Copies the tree under `source` into the existing directory `dest` and returns the bytes of regular files. Each file
 * is requested as a copy-on-write clone (`COPYFILE_FICLONE`, which libuv clones on Linux file systems with reflinks and
 * otherwise copies); symlinks are recreated with their target text unchanged. Other file types (sockets, FIFOs) are skipped.
 */
async function jsCopy(source: string, dest: string, copy: NonNullable<WorkspaceCopyOptions["copyFile"]>, signal?: AbortSignal): Promise<number> {
	let total = 0;
	for (const entry of await readdir(source, { withFileTypes: true })) {
		signal?.throwIfAborted();
		const from = join(source, entry.name);
		const to = join(dest, entry.name);
		if (entry.isSymbolicLink()) await symlink(await readlink(from), to);
		else if (entry.isDirectory()) {
			await mkdir(to);
			total += await jsCopy(from, to, copy, signal);
		} else if (entry.isFile()) {
			await copy(from, to, constants.COPYFILE_FICLONE);
			total += (await lstat(from)).size;
		}
	}
	signal?.throwIfAborted();
	return total;
}

/**
 * Copies a workspace's contents into the empty directory `dest`, asynchronously, and returns the bytes of regular files
 * copied. On macOS it runs `/bin/cp -cRP`, which clones files with clonefile(2) on APFS and never follows symlinks; when
 * that fails (another file system), what it left is removed and the JS copy runs instead. Elsewhere the JS copy runs:
 * a clone where the file system supports reflinks, a plain copy otherwise. Symlinks are copied as links, their targets
 * unchanged. On failure or abort, `dest` may hold a partial copy.
 */
export async function copyWorkspaceTree(source: string, dest: string, options: WorkspaceCopyOptions = {}): Promise<number> {
	const { signal } = options;
	const copy = options.copyFile ?? ((from, to, mode) => copyFile(from, to, mode));
	signal?.throwIfAborted();
	if ((options.platform ?? process.platform) === "darwin") {
		try {
			await (options.runCp ?? defaultRunCp)(["-cRP", `${source}/.`, dest], signal);
			return await regularFileBytes(dest);
		} catch (error) {
			if (signal?.aborted) throw error;
			await emptyDir(dest);
		}
	}
	return jsCopy(source, dest, copy, signal);
}
