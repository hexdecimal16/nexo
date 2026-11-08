import { createInterface } from "node:readline/promises";
import type { ApprovalAnswer, ApprovalRequest, Prompter, Question, QuestionAnswer, QuestionAnswerItem, QuestionRequest } from "@nexo/tools";

/** Model text on one terminal line: control characters become spaces. */
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

/** `2` or `1,3` picks options (numbers in range; one only for single-select); anything else is a typed answer. */
export function parseTtyAnswer(q: Question, raw: string): QuestionAnswerItem {
	if (/^\d+(\s*,\s*\d+)*$/.test(raw)) {
		const picks = [...new Set(raw.split(",").map((s) => Number(s.trim())))];
		if (picks.every((n) => n >= 1 && n <= q.options.length) && (q.multiSelect || picks.length === 1)) {
			return { question: q.question, selected: q.options.filter((_, i) => picks.includes(i + 1)).map((o) => o.label) };
		}
	}
	return { question: q.question, selected: [], text: raw };
}

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

	const askQuestions = async (request: QuestionRequest, signal: AbortSignal | undefined): Promise<QuestionAnswer | null> => {
		if (signal?.aborted) return null;
		const rl = createInterface({ input, output });
		try {
			const answers: QuestionAnswerItem[] = [];
			for (const q of request.questions) {
				const lines = [`${q.header ? `[${clean(q.header)}] ` : ""}${clean(q.question)}`];
				q.options.forEach((o, i) => lines.push(`  ${i + 1}. ${clean(o.label)}${o.description ? ` - ${clean(o.description)}` : ""}`));
				lines.push(`  ${q.multiSelect ? "Numbers separated by commas" : "A number"}, or type your own answer (empty skips all questions)`);
				const raw = (await rl.question(`${lines.join("\n")}\n> `, { signal })).trim();
				if (!raw) return null;
				answers.push(parseTtyAnswer(q, raw));
			}
			return { answers };
		} catch (error) {
			if (isAbortError(error) && !signal?.aborted) options.onInterrupt?.();
			return null;
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
		ask(request, signal) {
			const turn = queue.then(() => askQuestions(request, signal));
			queue = turn.catch(() => undefined);
			return turn;
		},
	};
}
