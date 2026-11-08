import { Container, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Question, QuestionAnswer, QuestionAnswerItem, QuestionRequest } from "@nexo/tools";
import { fitLines } from "./components.ts";
import { style } from "./theme.ts";

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const ESC = "\u001b";
const OTHER_LABEL = "Type your own answer";

export interface QuestionBoxOptions {
	/** Input before this time is dropped, so a keystroke typed ahead cannot answer. */
	guardUntil: number;
	now: () => number;
	/** Escapes and redacts model text before it is drawn. */
	clean: (text: string) => string;
}

/**
 * An `ask_user` box: one question at a time, ↑↓ to move, space to toggle (multi-select), enter to answer, and a
 * "Type your own answer" row that opens a one-line text field. Esc declines the whole request.
 */
export class QuestionBox extends Container {
	private index = 0;
	private cursor = 0;
	private picked = new Set<number>();
	private typing = false;
	private draft = "";
	private readonly answers: QuestionAnswerItem[] = [];
	private readonly request: QuestionRequest;
	private readonly onDone: (answer: QuestionAnswer | null) => void;
	private readonly options: QuestionBoxOptions;

	constructor(request: QuestionRequest, onDone: (answer: QuestionAnswer | null) => void, options: QuestionBoxOptions) {
		super();
		this.request = request;
		this.onDone = onDone;
		this.options = options;
	}

	private get question(): Question {
		return this.request.questions[this.index] as Question;
	}

	handleInput(data: string): void {
		if (this.options.now() < this.options.guardUntil) return;
		const q = this.question;
		const other = q.options.length;
		if (this.typing) {
			if (data === "\r" || data === "\n") {
				if (this.draft.trim()) this.commit([], this.draft.trim());
				else this.typing = false;
			} else if (data === ESC) this.typing = false;
			else if (data === "\x7f" || data === "\b") this.draft = [...this.draft].slice(0, -1).join("");
			else if (!data.includes(ESC)) this.draft += data.replace(/[\u0000-\u001f\u007f]/g, "");
			return;
		}
		const rows = other + 1;
		if (data === UP) this.cursor = (this.cursor - 1 + rows) % rows;
		else if (data === DOWN) this.cursor = (this.cursor + 1) % rows;
		else if (data === " " && q.multiSelect && this.cursor < other) {
			if (this.picked.has(this.cursor)) this.picked.delete(this.cursor);
			else this.picked.add(this.cursor);
		} else if (data === "\r" || data === "\n") {
			if (this.cursor === other) {
				this.typing = true;
				this.draft = "";
			} else if (q.multiSelect) {
				if (this.picked.size === 0) this.picked.add(this.cursor);
				this.commit(q.options.filter((_, i) => this.picked.has(i)).map((o) => o.label));
			} else this.commit([(q.options[this.cursor] as { label: string }).label]);
		} else if (data === ESC) this.onDone(null);
	}

	private commit(selected: string[], text?: string): void {
		this.answers.push({ question: this.question.question, selected, ...(text ? { text } : {}) });
		this.index++;
		this.cursor = 0;
		this.picked = new Set();
		this.typing = false;
		this.draft = "";
		if (this.index >= this.request.questions.length) this.onDone({ answers: [...this.answers] });
	}

	override render(width: number): string[] {
		if (this.index >= this.request.questions.length) return [];
		const inner = Math.max(1, width - 4);
		const clean = this.options.clean;
		const border = (s: string) => style.cyan(s);
		const row = (s: string) => `${border("│")} ${truncateToWidth(s, inner, "…", true)} ${border("│")}`;
		const q = this.question;
		const total = this.request.questions.length;
		const lines = [border(`╭${"─".repeat(inner + 2)}╮`)];
		const title = `Question${total > 1 ? ` ${this.index + 1}/${total}` : ""}${q.header ? ` · ${clean(q.header)}` : ""}`;
		lines.push(row(style.bold(style.cyan(title))));
		for (const line of wrapTextWithAnsi(clean(q.question), inner)) lines.push(row(line));
		lines.push(row(""));
		q.options.forEach((o, i) => {
			const mark = q.multiSelect ? (this.picked.has(i) ? "[x] " : "[ ] ") : "";
			const here = this.cursor === i;
			const label = `${here ? "→ " : "  "}${mark}${clean(o.label)}`;
			lines.push(row(here ? style.bold(label) : label));
			if (o.description) for (const line of wrapTextWithAnsi(clean(o.description), Math.max(1, inner - 4))) lines.push(row(style.gray(`    ${line}`)));
		});
		const onOther = this.cursor === q.options.length;
		const otherLabel = `${onOther ? "→ " : "  "}${OTHER_LABEL}`;
		lines.push(row(onOther ? style.bold(otherLabel) : otherLabel));
		if (this.typing) lines.push(row(`  › ${this.draft}▏`));
		lines.push(row(""));
		const hint = this.typing
			? "type your answer · enter send · esc back to the options"
			: `↑↓ choose${q.multiSelect ? " · space toggle" : ""} · enter answer · esc skip all questions · ctrl-c stop the turn`;
		for (const line of wrapTextWithAnsi(hint, inner)) lines.push(row(style.gray(line)));
		lines.push(border(`╰${"─".repeat(inner + 2)}╯`));
		return fitLines(lines, width);
	}
}
