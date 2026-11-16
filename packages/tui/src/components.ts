import { type Component, Container, CURSOR_MARKER, type Focusable, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { duration, escapeControl, oneLine, previewLines, resultLines, usd } from "./text.ts";
import { style } from "./theme.ts";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Shared animation frame for every running line; the chat advances it while a turn runs. */
export class Ticker {
	frame = 0;
	get spinner(): string {
		return SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] as string;
	}
}

/** Cuts every line to the width, so no child can make pi-tui throw on an over-wide line. */
export function fitLines(lines: string[], width: number): string[] {
	return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}

/** A Container whose rendered lines never exceed the width. */
export class SafeContainer extends Container {
	override render(width: number): string[] {
		return fitLines(super.render(width), width);
	}
}

/** Markdown whose rendered lines never exceed the width. */
export class SafeMarkdown extends Markdown {
	override render(width: number): string[] {
		return fitLines(super.render(width), width);
	}
}

/** One line whose text is computed at render time, cut to the width. */
export class DynamicLine implements Component {
	private readonly text: () => string;
	constructor(text: () => string) {
		this.text = text;
	}
	render(width: number): string[] {
		return [truncateToWidth(this.text(), width)];
	}
	invalidate(): void {}
}

/** Most queued messages listed before the rest collapse into `+N more`. */
export const QUEUE_SHOWN = 3;

/** Messages waiting for the running turn to end, one dim line each; renders nothing when empty. */
export class QueuedList implements Component {
	private readonly items: () => readonly string[];
	constructor(items: () => readonly string[]) {
		this.items = items;
	}
	render(width: number): string[] {
		const items = this.items();
		if (items.length === 0) return [];
		const lines = [""];
		items.slice(0, QUEUE_SHOWN).forEach((item, i) => {
			lines.push(truncateToWidth(style.dim(`  ⏵ ${i + 1} ${escapeControl(oneLine(item, 200))}`), width));
		});
		if (items.length > QUEUE_SHOWN) lines.push(truncateToWidth(style.gray(`  … +${items.length - QUEUE_SHOWN} more`), width));
		return lines;
	}
	invalidate(): void {}
}

/** Static text, wrapped to the width (text must already be control-escaped). */
export class Block implements Component {
	private text: string;
	private readonly color: (s: string) => string;
	private readonly prefix: string;
	constructor(text: string, color: (s: string) => string = (s) => s, prefix = "") {
		this.text = text;
		this.color = color;
		this.prefix = prefix;
	}
	setText(text: string): void {
		this.text = text;
	}
	render(width: number): string[] {
		const pad = visibleWidth(this.prefix);
		const out: string[] = [""];
		const lines = this.text.split("\n");
		lines.forEach((line, i) => {
			const wrapped = wrapTextWithAnsi(line, Math.max(1, width - pad));
			wrapped.forEach((w, j) => {
				const lead = i === 0 && j === 0 ? this.prefix : " ".repeat(pad);
				out.push(truncateToWidth(this.color(lead + w), width));
			});
		});
		return out;
	}
	invalidate(): void {}
}

type LineState = "running" | "ok" | "error";

/** Whether tool lines show their full arguments and output (ctrl+o); shared by every line in the chat. */
export class ViewMode {
	verbose = false;
}

/** `● tool(args)` with a spinner while running, then `✓`/`✗`, duration and a short result preview, or everything when verbose. */
export class ToolLine implements Component {
	private state: LineState = "running";
	private durationMs = 0;
	private preview: string[] = [];
	private output: string[] = [];
	private readonly summary: string;
	private readonly fullSummary: string;
	private readonly ticker: Ticker;
	private readonly view: ViewMode;
	constructor(summary: string, fullSummary: string, ticker: Ticker, view: ViewMode) {
		this.summary = summary;
		this.fullSummary = fullSummary;
		this.ticker = ticker;
		this.view = view;
	}
	finish(isError: boolean, durationMs: number, output: string): void {
		this.state = isError ? "error" : "ok";
		this.durationMs = durationMs;
		this.preview = previewLines(output);
		this.output = resultLines(output);
	}
	/** Marks a line still running when its turn ended (aborted or failed). */
	interrupt(): void {
		if (this.state === "running") this.state = "error";
	}
	render(width: number): string[] {
		const mark = this.state === "running" ? style.cyan(this.ticker.spinner) : this.state === "ok" ? style.green("✓") : style.red("✗");
		const tail = this.state === "running" ? "" : style.gray(` ${duration(this.durationMs)}`);
		if (!this.view.verbose) {
			const lines = ["", truncateToWidth(`${mark} ${style.bold(this.summary)}${tail}`, width)];
			this.preview.forEach((line, i) => {
				lines.push(truncateToWidth(style.gray(`${i === 0 ? "  ⎿ " : "    "}${line}`), width));
			});
			return lines;
		}
		const lines = [""];
		wrapTextWithAnsi(`${style.bold(this.fullSummary)}${tail}`, Math.max(1, width - 2)).forEach((w, i) => {
			lines.push(truncateToWidth(`${i === 0 ? `${mark} ` : "  "}${w}`, width));
		});
		this.output.forEach((line, i) => {
			wrapTextWithAnsi(line, Math.max(1, width - 4)).forEach((w, j) => {
				lines.push(truncateToWidth(style.gray(`${i === 0 && j === 0 ? "  ⎿ " : "    "}${w}`), width));
			});
		});
		return lines;
	}
	invalidate(): void {}
}

/** One entry per spawned subagent: task id, model, elapsed time, current tool and, on failure, the error. */
export class SubagentLine implements Component {
	private state: LineState = "running";
	private costUsd = 0;
	private status = "";
	private error = "";
	private tool = "";
	private approval = "";
	private toolCalls = 0;
	private endedAt: number | null = null;
	private readonly startedAt = Date.now();
	private readonly summary: string;
	private readonly ticker: Ticker;
	private readonly depth: number;
	private readonly label: string;
	/** One line only (no current-tool, approval or error line), for when the live panel is short on rows. */
	compact = false;
	constructor(summary: string, depth: number, ticker: Ticker, label: string) {
		this.summary = summary;
		this.depth = depth;
		this.ticker = ticker;
		this.label = label;
	}
	toolStarted(summary: string): void {
		this.tool = summary;
		this.toolCalls++;
	}
	toolEnded(): void {
		this.tool = "";
	}
	/** Keeps only the latest auto-approval reason; it replaces the previous one instead of piling up in the chat. */
	approved(reason: string): void {
		this.approval = reason;
	}
	finish(status: string, costUsd: number, error = ""): void {
		this.state = status === "succeeded" ? "ok" : "error";
		this.status = status;
		this.costUsd = costUsd;
		this.error = error;
		this.tool = "";
		this.approval = "";
		this.endedAt = Date.now();
	}
	get running(): boolean {
		return this.state === "running";
	}
	interrupt(): void {
		if (this.state === "running") {
			this.state = "error";
			this.status = "interrupted";
			this.tool = "";
			this.approval = "";
			this.endedAt = Date.now();
		}
	}
	render(width: number): string[] {
		const indent = "  ".repeat(Math.max(0, this.depth - 1));
		const mark = this.state === "running" ? style.cyan(this.ticker.spinner) : this.state === "ok" ? style.green("✓") : style.red("✗");
		const elapsed = duration((this.endedAt ?? Date.now()) - this.startedAt);
		const calls = this.toolCalls > 0 ? ` · ${this.toolCalls} tool${this.toolCalls === 1 ? "" : "s"}` : "";
		const tail = this.state === "running" ? style.gray(` ${elapsed}${calls}`) : style.gray(` ${this.status} · ${elapsed}${calls} · ${usd(this.costUsd)}`);
		const lines = [truncateToWidth(`${indent}  ↳ ${mark} ${style.bold(this.label)} ${this.summary}${tail}`, width)];
		if (this.compact) return lines;
		if (this.state === "running" && this.tool) lines.push(truncateToWidth(style.gray(`${indent}      ${this.tool}`), width));
		if (this.state === "running" && this.approval) lines.push(truncateToWidth(style.gray(`${indent}      auto-allowed: ${this.approval}`), width));
		if (this.state === "error" && this.error) lines.push(truncateToWidth(style.red(`${indent}      ${this.error}`), width));
		return lines;
	}
	invalidate(): void {}
}

/**
 * The subagents of the running fan-out, pinned below the chat. Their rows animate (spinner, elapsed time), and the
 * main-screen renderer clears scrollback and redraws everything whenever a line above the viewport changes, so live rows
 * must never sit in the chat where new output can push them off screen. Finished rows wait here until the whole wave is
 * done and are then moved into the chat in one go (see `takeFinished`), where they never change again. The panel never
 * renders more than `maxRows()` lines: first finished rows collapse into one line, then running rows go one line each,
 * then the rest are counted.
 */
export class SubagentPanel implements Component {
	private readonly lines: SubagentLine[] = [];
	private readonly maxRows: () => number;
	constructor(maxRows: () => number) {
		this.maxRows = maxRows;
	}
	add(line: SubagentLine): void {
		this.lines.push(line);
	}
	get anyRunning(): boolean {
		return this.lines.some((line) => line.running);
	}
	/** Removes and returns every row, in start order, expanded for the chat. */
	takeFinished(): SubagentLine[] {
		const taken = this.lines.splice(0);
		for (const line of taken) line.compact = false;
		return taken;
	}
	clear(): void {
		this.lines.length = 0;
	}
	render(width: number): string[] {
		if (this.lines.length === 0) return [];
		const budget = Math.max(3, this.maxRows());
		for (const line of this.lines) line.compact = false;
		const full = [""].concat(...this.lines.map((line) => line.render(width)));
		if (full.length <= budget) return full;
		const running = this.lines.filter((line) => line.running);
		const done = this.lines.length - running.length;
		const out = [""];
		if (done > 0) out.push(truncateToWidth(style.gray(`  ↳ ${done} subagent${done === 1 ? "" : "s"} finished`), width));
		for (const line of running) line.compact = true;
		const room = budget - out.length;
		const shown = running.length <= room ? running : running.slice(0, Math.max(0, room - 1));
		for (const line of shown) out.push(...line.render(width));
		const hidden = running.length - shown.length;
		if (hidden > 0) out.push(truncateToWidth(style.gray(`  ↳ … +${hidden} more running`), width));
		return out;
	}
	invalidate(): void {}
}

/**
 * Single-line secret entry. Shows one bullet per character and nothing else; the value is handed to `onSubmit` and
 * dropped. It keeps no history, undo or kill ring.
 */
export class MaskedInput implements Component, Focusable {
	focused = false;
	onSubmit?: (value: string) => void;
	onCancel?: () => void;
	private value = "";
	private inPaste = false;
	private pasteBuffer = "";
	private readonly prompt: string;
	constructor(prompt: string) {
		this.prompt = prompt;
	}
	get length(): number {
		return this.value.length;
	}
	handleInput(data: string): void {
		if (this.inPaste && (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))) {
			this.clear();
			this.onCancel?.();
			return;
		}
		if (data.includes("\x1b[200~")) {
			this.inPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}
		if (this.inPaste) {
			this.pasteBuffer += data;
			const end = this.pasteBuffer.indexOf("\x1b[201~");
			if (end === -1) return;
			this.value += this.pasteBuffer.slice(0, end).replace(/[\r\n]/g, "");
			this.pasteBuffer = "";
			this.inPaste = false;
			return;
		}
		if (matchesKey(data, "enter")) {
			const value = this.value;
			this.clear();
			this.onSubmit?.(value);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.clear();
			this.onCancel?.();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.value = this.value.slice(0, -1);
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.value = "";
			return;
		}
		// Printable characters only; escape sequences (arrows, function keys) are ignored.
		if (!data.startsWith("\x1b") && !/[\u0000-\u001f\u007f]/.test(data)) this.value += data;
	}
	clear(): void {
		this.value = "";
		this.pasteBuffer = "";
		this.inPaste = false;
	}
	render(width: number): string[] {
		const bullets = "•".repeat(Math.min(this.value.length, Math.max(0, width - visibleWidth(this.prompt) - 2)));
		const cursor = this.focused ? CURSOR_MARKER : "";
		return [truncateToWidth(`${this.prompt}${bullets}${cursor}`, width)];
	}
	invalidate(): void {}
}
