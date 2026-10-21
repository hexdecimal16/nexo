import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** How long a process group gets between SIGTERM and SIGKILL after an abort. */
const KILL_GRACE_MS = 2_000;

/** One CLI invocation: the arguments after the executable, the prompt on stdin and the working directory. */
export interface SpawnRequest {
	args: string[];
	stdin: string;
	cwd: string;
	signal?: AbortSignal;
	/** Receives stderr as it arrives. */
	onStderr?: (chunk: string) => void;
}

/** A running invocation: its stdout lines and its exit. */
export interface SpawnedProcess {
	lines: AsyncIterable<string>;
	exit: Promise<{ code: number | null; stderr: string }>;
}

const isWindows = process.platform === "win32";
const liveGroups = new Set<number>();
let exitHandlerRegistered = false;

function killLiveGroups(): void {
	for (const pgid of liveGroups) {
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {
			// the process group already exited
		}
	}
	liveGroups.clear();
}

function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
	try {
		if (!isWindows && child.pid !== undefined) process.kill(-child.pid, sig);
		else child.kill(sig);
	} catch {
		// the process group already exited
	}
}

/**
 * Spawns `command` in its own process group. On abort the whole group gets SIGTERM (SIGKILL after a grace period), and
 * `lines` and `exit` settle at once instead of waiting for the pipes to close: the CLIs we run start helpers of their
 * own, and one that outlives the signal would otherwise hold the pipes open and keep the caller waiting. The groups
 * are also killed when the host exits.
 */
export function spawnGroup(command: string, request: SpawnRequest): SpawnedProcess {
	const { args, stdin, cwd, signal, onStderr } = request;
	const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: !isWindows });
	const pgid = child.pid;
	if (pgid !== undefined && !isWindows) {
		if (!exitHandlerRegistered) {
			exitHandlerRegistered = true;
			process.on("exit", killLiveGroups);
		}
		liveGroups.add(pgid);
	}

	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		if (stderr.length < 16_384) stderr += chunk;
		onStderr?.(chunk);
	});
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

	let finish!: (result: { code: number | null; stderr: string }) => void;
	const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => {
		finish = resolve;
	});
	let killTimer: NodeJS.Timeout | undefined;
	const cleanup = () => {
		if (pgid !== undefined) liveGroups.delete(pgid);
		if (killTimer) clearTimeout(killTimer);
		signal?.removeEventListener("abort", onAbort);
	};
	const onAbort = () => {
		signalGroup(child, "SIGTERM");
		killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
		killTimer.unref();
		child.stdout.destroy();
		child.stderr.destroy();
		lines.close();
		finish({ code: null, stderr });
	};
	child.on("error", (error) => {
		cleanup();
		finish({ code: null, stderr: stderr || error.message });
	});
	child.on("close", (code) => {
		cleanup();
		finish({ code, stderr });
	});
	child.stdin.on("error", () => {});
	child.stdin.end(stdin);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	return { lines, exit };
}
