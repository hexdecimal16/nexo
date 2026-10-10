import { createInterface, type Interface } from "node:readline/promises";
import { type Db, recordFeedback } from "@nexo/store";
import type { Redactor } from "@nexo/telemetry";

/**
 * Asks one line on the terminal; resolves null when the user presses Ctrl-C, input ends or `signal` aborts.
 * `close` releases the terminal after the last question.
 */
export interface LineAsker {
	ask(question: string, signal?: AbortSignal): Promise<string | null>;
	close?(): void;
}

export type ReviewChoice = "done" | "not_done" | "skip";

export interface ReviewIO {
	stderr: { write(text: string): boolean };
}

/** Maps an answer to the `[d]one / [n]ot done / [s]kip` prompt; an empty answer is skip, anything unrecognised is null. */
export function parseReviewAnswer(answer: string): ReviewChoice | null {
	const a = answer.trim().toLowerCase();
	if (a === "" || a === "s" || a === "skip") return "skip";
	if (a === "d" || a === "done") return "done";
	if (a === "n" || a === "not done" || a === "not_done") return "not_done";
	return null;
}

/**
 * True only when a person can both see and answer the prompt: stdin, stdout and stderr are all terminals. The prompt is
 * written to stderr, so a redirected stderr (`2>log`) must not leave the run waiting on a question nobody sees.
 */
export function isInteractiveTerminal(stdio: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean }; stderr: { isTTY?: boolean } }): boolean {
	return stdio.stdin.isTTY === true && stdio.stdout.isTTY === true && stdio.stderr.isTTY === true;
}

/** One readline interface serves every question, so input typed ahead of a question is kept for the next one. */
export function createTtyLineAsker(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): LineAsker {
	let rl: Interface | null = null;
	let closed = false;
	const lines: string[] = [];
	let waiter: ((line: string | null) => void) | null = null;

	const finish = (line: string | null): void => {
		const resolve = waiter;
		waiter = null;
		resolve?.(line);
	};
	const open = (): Interface => {
		if (rl) return rl;
		rl = createInterface({ input, output });
		rl.on("line", (line) => {
			if (waiter) finish(line);
			else lines.push(line);
		});
		const end = (): void => {
			closed = true;
			finish(null);
		};
		rl.on("SIGINT", end);
		rl.on("close", end);
		return rl;
	};

	return {
		ask(question, signal) {
			if (signal?.aborted || closed) return Promise.resolve(null);
			const buffered = lines.shift();
			const iface = open();
			if (buffered !== undefined) {
				output.write(question);
				return Promise.resolve(buffered);
			}
			return new Promise<string | null>((resolve) => {
				const onAbort = (): void => {
					finish(null);
					iface.close();
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				waiter = (line) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(line);
				};
				iface.setPrompt(question);
				iface.prompt();
			});
		},
		close() {
			closed = true;
			rl?.close();
		},
	};
}

/**
 * The post-run review prompt (spec §7.1 step 6). A verdict is written through `recordFeedback`; skip, Ctrl-C, end of
 * input or three unrecognised answers leave the run unreviewed, so it appears in the UI review queue.
 */
export async function promptReview(options: { asker: LineAsker; db: Db; runId: string; redact: Redactor; io: ReviewIO; signal?: AbortSignal; now?: () => Date }): Promise<ReviewChoice> {
	try {
		return await askAndRecord(options);
	} finally {
		options.asker.close?.();
	}
}

async function askAndRecord(options: { asker: LineAsker; db: Db; runId: string; redact: Redactor; io: ReviewIO; signal?: AbortSignal; now?: () => Date }): Promise<ReviewChoice> {
	const { asker, io, signal } = options;
	let choice: ReviewChoice | null = null;
	for (let attempt = 0; attempt < 3 && choice === null; attempt++) {
		const answer = await asker.ask("Review this run: [d]one / [n]ot done / [s]kip ", signal);
		if (answer === null) {
			choice = "skip";
			break;
		}
		choice = parseReviewAnswer(answer);
		if (choice === null) io.stderr.write("Answer d, n or s.\n");
	}
	if (choice === null || choice === "skip") {
		io.stderr.write("Skipped. The run is waiting in the review queue of `nexo ui`.\n");
		return "skip";
	}
	const comment = choice === "not_done" ? ((await asker.ask("What was missing or wrong? (optional) ", signal)) ?? "") : "";
	recordFeedback(options.db, {
		runId: options.runId,
		verdict: choice,
		comment,
		nowIso: (options.now ?? (() => new Date()))().toISOString(),
		redact: options.redact,
	});
	io.stderr.write(`Recorded verdict: ${choice === "done" ? "done" : "not done"}.\n`);
	return choice;
}
