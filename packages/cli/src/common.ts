import type { Models } from "@earendil-works/pi-ai";
import { type ErrorPayload, NexoError, type NexoErrorCode } from "@nexo/telemetry";
import type { Prompter } from "@nexo/tools";
import type { InteractiveOptions } from "@nexo/tui";
import type { LineAsker } from "./review.ts";

export interface CliIO {
	stdout: { write(text: string): boolean };
	stderr: { write(text: string): boolean };
}

/** The process streams a command looks at: terminal detection and the key prompt. Tests pass fakes. */
export interface CliStdio {
	stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
	stdout: { isTTY?: boolean };
	stderr: { isTTY?: boolean };
}

/** The slice of `process` that interactive mode installs crash handlers on. */
export type ProcessLike = Pick<NodeJS.Process, "on" | "off">;

export interface CliOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	models?: Models;
	prompter?: Prompter;
	/** Asks the post-run review question. Undefined: a terminal asker when stdin, stdout and stderr are TTYs. Null: never ask. */
	reviewAsker?: LineAsker | null;
	signal?: AbortSignal;
	/** Default: the process streams. */
	stdio?: CliStdio;
	/** Terminal for the chat, settings and `--resume` picker screens. Default: pi-tui's ProcessTerminal. */
	terminal?: InteractiveOptions["terminal"];
	/** Receives the crash handlers of interactive mode. Default: `process`. */
	proc?: ProcessLike;
	/** Called with the exit code when interactive mode ends, so a stuck turn cannot keep the process alive. bin.ts passes process.exit. */
	exit?: (code: number) => void;
}

export const USAGE = `Usage:
  nexo                                     start an interactive session (needs a terminal)
  nexo --resume [id]                       resume a session (a picker when no id is given)
  nexo [--workspace <dir>] [--model <s1|s2|provider/id>] [--effort <level>]   options for a new session
                                           without --workspace each turn works in its own run folder (files carried over
                                           from the previous turn); --workspace . works in the current folder
  nexo sessions [--limit <n>]
  nexo settings                            open the settings screen (needs a terminal)
  nexo settings get <key>
  nexo settings set <key> <value>          keys: models.s1|s2|judge|reflector|embedding, budgets.*, tools.policy.*, tools.autoApprove, tools.nonInteractiveAsk, models.approver, scoring.judge, learning.*, memory.*, optimize.minCases|patience|minJudgeKappa|noveltySimilarity|offspringAlpha
  nexo settings reset <key>                remove it from the user config
  nexo settings set-key <provider>         reads the key from a hidden prompt, or from stdin when piped
  nexo run <instruction...> [--skill <name>] [--model <s1|s2|provider/id>] [--effort <level>] [--workspace <dir>] [--budget <usd>] [--no-review]
  nexo cost [--by model|tier|day|run|skill] [--since YYYY-MM-DD]
  nexo reindex
  nexo eval judge [--judge <provider/id[+provider/id…]>]   judge-vs-human agreement and Cohen's κ
  nexo eval add --target <target> --input <text> [--skill <name>] [--expected <text>] [--feedback <text>]
  nexo eval list --target <target>
  nexo eval mine --target <target> [--days <n>]   propose eval cases from unreviewed runs
  nexo eval accept <case-id> [--expected <text>]
  nexo eval dismiss <case-id>
  nexo eval golden revert <case-id>
  nexo optimize --target skill:<name>|system_prompt|planner_prompt|judge_rubric [--budget-usd <n>] [--max-rollouts <n>] [--merge] [--seed <n>]
  nexo optimize climb --target skill:<name>|system_prompt|planner_prompt [--case <id>] [--guards <0-10>] [--budget-usd <n>] [--seed <n>]
  nexo optimize list
  nexo optimize show <id> [--diff]
  nexo optimize approve <id>               promote the best candidate (refused on weak evidence)
  nexo optimize rollback <id>              reactivate the version an approval replaced
  nexo learn [--retry]                     run pending learn jobs (--retry: failed ones with attempts left too)
  nexo memory list [--scope user|global|skill:<name>] [--type fact|preference|lesson|workflow] [--all]
  nexo memory add <text...> [--scope …] [--type …] [--importance 0..1]
  nexo memory retire <id>
  nexo playbook show <skill> [--all]
  nexo playbook add <skill> <text...>
  nexo playbook retire <skill> <key>
  nexo doctor [--json]                     check Node, config, keys and the data directory (exit 1 on a failure)
  nexo ui [--port <n>]
`;

export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

export function exitCodeFor(code: NexoErrorCode | undefined): number {
	switch (code) {
		case undefined:
			return 0;
		case "CONFIG_INVALID":
			return 2;
		case "BUDGET_EXCEEDED":
			return 3;
		case "PROVIDER_AUTH":
			return 4;
		default:
			return 1;
	}
}

/** Prints an error; `redact` (the settings' live redactor) is applied to the message and hint so a stored key cannot leak. */
export function printError(io: CliIO, error: ErrorPayload, redact: (text: string) => string = (text) => text): void {
	io.stderr.write(`error [${error.code}]: ${redact(error.message)}\n`);
	if (error.hint) io.stderr.write(`hint: ${redact(error.hint)}\n`);
}

export function usageError(message: string): NexoError {
	return new NexoError({ code: "CONFIG_INVALID", message, hint: USAGE.trim() });
}

export function isTerminalStdio(stdio: CliStdio): boolean {
	return stdio.stdin.isTTY === true && stdio.stdout.isTTY === true && stdio.stderr.isTTY === true;
}

export function requireTerminal(stdio: CliStdio, what: string): void {
	if (!isTerminalStdio(stdio)) {
		throw new NexoError({
			code: "CONFIG_INVALID",
			message: `${what} needs an interactive terminal (stdin, stdout and stderr must all be TTYs)`,
			hint: `For scripts use \`nexo run "<instruction>"\`, \`nexo settings get|set|reset|set-key\` or \`nexo sessions\`.\n${USAGE.trim()}`,
		});
	}
}
