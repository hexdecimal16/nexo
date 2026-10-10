import { createInterface } from "node:readline/promises";
import type { Prompter } from "@nexo/tools";

export function createTtyPrompter(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Prompter {
	return {
		interactive: Boolean(input.isTTY),
		async confirm(question, signal) {
			const rl = createInterface({ input, output });
			try {
				const answer = await rl.question(`${question} [y/N] `, { signal });
				return /^y(es)?$/i.test(answer.trim());
			} catch {
				return false;
			} finally {
				rl.close();
			}
		},
	};
}
