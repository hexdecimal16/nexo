import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";

/** A pi-tui Terminal without a TTY: records every write and lets a test type keys. */
export class FakeTerminal implements Terminal {
	writes: string[] = [];
	started = false;
	stopped = false;
	private onInput: ((data: string) => void) | null = null;
	private width: number;
	private height: number;

	constructor(columns = 100, rows = 40) {
		this.width = columns;
		this.height = rows;
	}

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.started = true;
		this.stopped = false;
		this.onInput = onInput;
	}

	stop(): void {
		this.stopped = true;
		this.onInput = null;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.width;
	}

	get rows(): number {
		return this.height;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}

	/** Sends raw input, as one chunk. */
	send(data: string): void {
		if (!this.onInput) throw new Error("terminal is not started");
		this.onInput(data);
	}

	/** Types text one character at a time. */
	type(text: string): void {
		for (const ch of text) this.send(ch);
	}

	/** Everything written so far, with escape sequences removed. */
	output(): string {
		return stripTerminalSequences(this.writes.join(""));
	}

	/** What the last full redraw (clear screen and scrollback) and everything after it wrote, with escape sequences removed. */
	screen(): string {
		const raw = this.raw();
		return stripTerminalSequences(raw.slice(raw.lastIndexOf("\x1b[3J")));
	}

	/** Raw output including escape sequences. */
	raw(): string {
		return this.writes.join("");
	}
}

export const KEY = {
	enter: "\r",
	escape: "\x1b",
	ctrlC: "\x03",
	ctrlD: "\x04",
	ctrlO: "\x0f",
	/** Kitty keyboard protocol: ctrl+o press, then its release. */
	ctrlOPress: "\x1b[111;5u",
	ctrlORelease: "\x1b[111;5:3u",
	ctrlCRelease: "\x1b[99;5:3u",
	up: "\x1b[A",
	down: "\x1b[B",
	backspace: "\x7f",
} as const;

/** Polls until `check` passes (or throws its last error after `timeoutMs`). */
export async function until(check: () => boolean | void, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	let last: unknown;
	for (;;) {
		try {
			const result = check();
			if (result !== false) return;
			last = new Error("condition not met");
		} catch (error) {
			last = error;
		}
		if (Date.now() - start > timeoutMs) throw last;
		await new Promise((r) => setTimeout(r, 10));
	}
}
