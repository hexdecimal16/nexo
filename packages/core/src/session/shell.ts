import type { ShellNote } from "@nexo/store";

/** Most characters of one command's output the model reads; the end is kept, where errors and summaries usually are. */
export const SHELL_NOTE_CHARS = 20_000;

/** Keeps the last SHELL_NOTE_CHARS characters of `output`, marking the cut. */
export function capShellOutput(output: string, truncated = false): string {
	const kept = output.length > SHELL_NOTE_CHARS ? `[…${output.length - SHELL_NOTE_CHARS} characters cut]\n${output.slice(-SHELL_NOTE_CHARS)}` : output;
	return truncated ? `${kept}\n[output truncated]` : kept;
}

function outcome(note: ShellNote): string {
	switch (note.ended) {
		case "exited":
			return `exit code ${note.exitCode ?? -1}`;
		case "timeout":
			return "timed out";
		case "aborted":
			return "stopped by the user";
		case "failed":
			return "failed to start";
	}
}

/** The user message for a turn that follows `!` commands: the commands with their output, then what the user typed. */
export function withShellNotes(notes: readonly ShellNote[], instruction: string): string {
	if (notes.length === 0) return instruction;
	const blocks = notes.map((n) => `$ ${n.command}\n[${outcome(n)}]\n${n.output.replace(/\n$/, "")}`);
	return `[nexo] Before this message the user ran shell commands in the workspace:\n\n${blocks.join("\n\n")}\n\n[nexo] The user's message:\n${instruction}`;
}
