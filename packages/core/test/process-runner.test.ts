import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { spawnGroup } from "../src/providers/process-runner.ts";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(check: () => boolean, ms = 3_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return check();
}

describe.skipIf(process.platform === "win32")("spawnGroup", () => {
	it("streams stdout lines and reports the exit", async () => {
		const proc = spawnGroup("bash", { args: ["-c", "cat; echo err >&2"], stdin: "hello\n", cwd: tmpdir() });
		const lines: string[] = [];
		for await (const line of proc.lines) lines.push(line);
		const exit = await proc.exit;
		expect(lines).toEqual(["hello"]);
		expect(exit).toEqual({ code: 0, stderr: "err\n" });
	});

	it("returns promptly on abort and kills the child's own children", async () => {
		const abort = new AbortController();
		const proc = spawnGroup("bash", { args: ["-c", "sleep 60 & echo $!; wait"], stdin: "", cwd: tmpdir(), signal: abort.signal });
		const iterator = proc.lines[Symbol.asyncIterator]();
		const first = await iterator.next();
		const grandchild = Number(first.value);
		expect(alive(grandchild)).toBe(true);

		const started = Date.now();
		abort.abort();
		const [exit, next] = await Promise.all([proc.exit, iterator.next()]);

		expect(next.done).toBe(true);
		expect(exit.code).toBeNull();
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(await until(() => !alive(grandchild))).toBe(true);
	});

	it("kills a child that ignores SIGTERM once the grace period passes", async () => {
		const abort = new AbortController();
		const proc = spawnGroup("bash", { args: ["-c", "trap '' TERM; sleep 60 & echo $!; while true; do sleep 1; done"], stdin: "", cwd: tmpdir(), signal: abort.signal });
		const iterator = proc.lines[Symbol.asyncIterator]();
		const grandchild = Number((await iterator.next()).value);
		abort.abort();
		await proc.exit;
		expect(await until(() => !alive(grandchild), 5_000)).toBe(true);
	}, 10_000);

	it("does not run anything meaningful when the signal is already aborted", async () => {
		const abort = new AbortController();
		abort.abort();
		const proc = spawnGroup("bash", { args: ["-c", "sleep 60"], stdin: "", cwd: tmpdir(), signal: abort.signal });
		const started = Date.now();
		await proc.exit;
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
