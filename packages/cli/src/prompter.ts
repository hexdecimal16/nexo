import { createInterface } from "node:readline/promises";
import type { Prompter } from "@nexo/tools";

export interface TtyPrompterOptions {
	/** Called when the user presses Ctrl-C at a prompt; readline swallows the keystroke, so no SIGINT reaches the process. */
	onInterrupt?: () => void;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * Asks on the terminal. Questions are queued so only one readline owns stdin at a time: concurrent subagents each wait
 * for their own answer instead of sharing one keystroke.
 */
export function createTtyPrompter(input: NodeJS.ReadStream, output: NodeJS.WriteStream, options: TtyPrompterOptions = {}): Prompter {
	let queue: Promise<unknown> = Promise.resolve();

	const ask = async (question: string, signal: AbortSignal | undefined): Promise<boolean> => {
		if (signal?.aborted) return false;
		const rl = createInterface({ input, output });
		try {
			const answer = await rl.question(`${question} [y/N] `, { signal });
			return /^y(es)?$/i.test(answer.trim());
		} catch (error) {
			if (isAbortError(error) && !signal?.aborted) options.onInterrupt?.();
			return false;
		} finally {
			rl.close();
		}
	};

	return {
		interactive: Boolean(input.isTTY),
		confirm(question, signal) {
			const turn = queue.then(() => ask(question, signal));
			queue = turn;
			return turn;
		},
	};
}
