import { type Component, Container, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ApprovalAnswer, ApprovalRequest, Prompter } from "@nexo/tools";
import { fitLines } from "./components.ts";
import { escapeControl } from "./text.ts";
import { selectListTheme, style } from "./theme.ts";

/** The question, the optional note, the Allow once / Always allow / Deny list and a key hint, in a bordered box. */
class ApprovalBox extends Container {
	private readonly question: string;
	private readonly note: string | undefined;
	readonly list: SelectList;
	private readonly acceptInputAt: number;
	private readonly now: () => number;
	constructor(question: string, note: string | undefined, list: SelectList, guardMs: number, now: () => number) {
		super();
		this.question = question;
		this.note = note;
		this.list = list;
		this.now = now;
		this.acceptInputAt = now() + guardMs;
	}
	/** Keys typed ahead (for example an Enter meant for the editor) are dropped until the guard time has passed. */
	handleInput(data: string): void {
		if (this.now() < this.acceptInputAt) return;
		this.list.handleInput(data);
	}
	override render(width: number): string[] {
		return fitLines(this.renderBox(width), width);
	}
	private renderBox(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const border = (s: string) => style.yellow(s);
		const row = (s: string) => `${border("│")} ${truncateToWidth(s, inner, "…", true)} ${border("│")}`;
		const lines = [border(`╭${"─".repeat(inner + 2)}╮`)];
		lines.push(row(style.bold(style.yellow("Approval needed"))));
		for (const line of wrapTextWithAnsi(this.question, inner)) lines.push(row(line));
		if (this.note) for (const line of wrapTextWithAnsi(this.note, inner)) lines.push(row(style.gray(line)));
		lines.push(row(""));
		for (const line of this.list.render(inner)) lines.push(row(line));
		for (const line of wrapTextWithAnsi("↑↓ choose · enter select · esc deny · ctrl-c deny and stop the turn", inner)) lines.push(row(style.gray(line)));
		lines.push(border(`╰${"─".repeat(inner + 2)}╯`));
		return lines;
	}
}

/** Where the approval box is drawn. */
export interface ApprovalHost {
	/** Shows the box (focused) in place of the editor and returns a function that puts the editor back. */
	show(box: Component): () => void;
}

export interface ApprovalPrompterOptions {
	/** How long the box ignores input after it appears (default 400 ms). */
	guardMs?: number;
	now?: () => number;
	/** Applied to every question before it is shown (the policy builds it from unredacted tool arguments). */
	redact?: (text: string) => string;
}

/**
 * A policy Prompter that asks in a bordered box with Allow once, Always allow (when the request offers it) and Deny, drawn by the host in place of the editor. Questions are
 * queued, so concurrent subagents get one box each in turn. An aborted signal (Ctrl-C, turn end) closes the box and
 * denies. Deny is preselected and input is ignored for `guardMs`, so a keystroke typed ahead cannot approve a tool.
 */
export function createApprovalPrompter(host: ApprovalHost, options: ApprovalPrompterOptions = {}): Prompter {
	const guardMs = options.guardMs ?? 400;
	const now = options.now ?? Date.now;
	const redact = options.redact ?? ((text: string) => text);
	let queue: Promise<unknown> = Promise.resolve();

	const ask = (request: ApprovalRequest, signal: AbortSignal | undefined): Promise<ApprovalAnswer> =>
		new Promise<ApprovalAnswer>((resolve) => {
			if (signal?.aborted) return resolve("deny");
			if (request.settled?.()) return resolve("once");
			const options = [
				{ value: "once", label: "Allow once" },
				...(request.alwaysLabel ? [{ value: "always", label: request.alwaysLabel }] : []),
				{ value: "deny", label: "Deny" },
			];
			const list = new SelectList(options, options.length, selectListTheme);
			list.setSelectedIndex(options.length - 1);
			const note = request.note ? escapeControl(redact(request.note)) : undefined;
			const box: Component = new ApprovalBox(escapeControl(redact(request.question)), note, list, guardMs, now);
			const hide = host.show(box);
			let settled = false;
			const finish = (answer: ApprovalAnswer) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				hide();
				resolve(answer);
			};
			const onAbort = () => finish("deny");
			signal?.addEventListener("abort", onAbort, { once: true });
			list.onSelect = (item) => finish(item.value as ApprovalAnswer);
			list.onCancel = () => finish("deny");
		});

	return {
		interactive: true,
		approve(request, signal) {
			const next = queue.then(() => ask(request, signal));
			queue = next.catch(() => undefined);
			return next;
		},
	};
}
