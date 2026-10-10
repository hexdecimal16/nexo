import { createInterface } from "node:readline/promises";
import { type Db, recordFeedback } from "@nexo/store";
import type { Redactor } from "@nexo/telemetry";

/** Asks one line on the terminal; resolves null when the user presses Ctrl-C or input ends. */
export interface LineAsker {
	ask(question: string): Promise<string | null>;
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

export function createTtyLineAsker(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): LineAsker {
	return {
		async ask(question) {
			const rl = createInterface({ input, output });
			try {
				return await new Promise<string | null>((resolve) => {
					rl.once("SIGINT", () => resolve(null));
					rl.once("close", () => resolve(null));
					rl.question(question).then(resolve, () => resolve(null));
				});
			} finally {
				rl.close();
			}
		},
	};
}

/**
 * The post-run review prompt (spec §7.1 step 6). A verdict is written through `recordFeedback`; skip, Ctrl-C, end of
 * input or three unrecognised answers leave the run unreviewed, so it appears in the UI review queue.
 */
export async function promptReview(options: { asker: LineAsker; db: Db; runId: string; redact: Redactor; io: ReviewIO; now?: () => Date }): Promise<ReviewChoice> {
	const { asker, io } = options;
	let choice: ReviewChoice | null = null;
	for (let attempt = 0; attempt < 3 && choice === null; attempt++) {
		const answer = await asker.ask("Review this run: [d]one / [n]ot done / [s]kip ");
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
	const comment = choice === "not_done" ? ((await asker.ask("What was missing or wrong? (optional) ")) ?? "") : "";
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
