import { createInterface } from "node:readline/promises";
import type { ApprovalAnswer, ApprovalRequest, Prompter } from "@nexo/tools";

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

	const ask = async (request: ApprovalRequest, signal: AbortSignal | undefined): Promise<ApprovalAnswer> => {
		if (signal?.aborted) return "deny";
		if (request.settled?.()) return "once";
		const rl = createInterface({ input, output });
		try {
			const lines = [request.question];
			if (request.note) lines.push(`  ${request.note}`);
			if (request.alwaysLabel) lines.push(`  a = ${request.alwaysLabel}`);
			const answer = (await rl.question(`${lines.join("\n")} ${request.alwaysLabel ? "[y/a/N]" : "[y/N]"} `, { signal })).trim();
			if (/^y(es)?$/i.test(answer)) return "once";
			if (request.alwaysLabel && /^a(lways)?$/i.test(answer)) return "always";
			return "deny";
		} catch (error) {
			if (isAbortError(error) && !signal?.aborted) options.onInterrupt?.();
			return "deny";
		} finally {
			rl.close();
		}
	};

	return {
		interactive: Boolean(input.isTTY),
		approve(request, signal) {
			const turn = queue.then(() => ask(request, signal));
			queue = turn.catch(() => undefined);
			return turn;
		},
	};
}
