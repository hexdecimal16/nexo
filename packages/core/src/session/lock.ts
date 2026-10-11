import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive } from "@nexo/store";
import { NexoError } from "@nexo/telemetry";

const LOCK_FILE = "session.lock";

const held = new Set<string>();
let exitHookInstalled = false;

function releaseAllOnExit(): void {
	for (const file of held) {
		try {
			unlinkSync(file);
		} catch {
			// already gone
		}
	}
	held.clear();
}

/**
 * Exclusive ownership of an open session across processes: `session.lock` in the session directory, created with
 * O_EXCL and holding the owner's pid. A lock whose pid is dead is taken over. Released by `release()` or at process exit.
 */
export class SessionLock {
	readonly file: string;
	private released = false;

	private constructor(file: string) {
		this.file = file;
	}

	/** Throws CONFLICT when a live process (this one included) holds the lock. */
	static acquire(sessionDir: string, sessionId: string): SessionLock {
		const file = join(sessionDir, LOCK_FILE);
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				writeFileSync(file, String(process.pid), { flag: "wx" });
				held.add(file);
				if (!exitHookInstalled) {
					process.on("exit", releaseAllOnExit);
					exitHookInstalled = true;
				}
				return new SessionLock(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw new NexoError({ code: "STORE_IO", message: `Cannot create ${file}`, cause: error });
				}
			}
			let pid = Number.NaN;
			try {
				pid = Number(readFileSync(file, "utf8").trim());
			} catch {
				// unreadable: treated as stale
			}
			if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
				throw new NexoError({
					code: "CONFLICT",
					message: `Session ${sessionId} is open in another nexo process (pid ${pid})`,
					hint: `Close that session first; if no nexo process is using it, delete ${file}`,
					context: { sessionId, pid },
				});
			}
			try {
				unlinkSync(file);
			} catch {
				// another process may have taken it over; the next attempt decides
			}
		}
		throw new NexoError({
			code: "CONFLICT",
			message: `Session ${sessionId} was locked by another process while opening it`,
			hint: "Retry",
			context: { sessionId },
		});
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		held.delete(this.file);
		try {
			unlinkSync(this.file);
		} catch {
			// already gone
		}
	}
}
