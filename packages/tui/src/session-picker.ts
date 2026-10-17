import { type Component, matchesKey, ProcessTerminal, type SelectItem, type Terminal, TuiMainScreen, truncateToWidth } from "@earendil-works/pi-tui";
import { startTui, stopTui } from "./app.ts";
import { fitLines, SafeContainer } from "./components.ts";
import { PickerView } from "./picker.ts";
import { escapeControl, oneLine, usd } from "./text.ts";
import { style } from "./theme.ts";

/** What the picker shows of a session. */
export interface SessionChoice {
	id: string;
	title: string;
	turns: number;
	costUsd: number;
	updatedAt: string;
}

function ago(iso: string, now: number): string {
	const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
	if (!Number.isFinite(minutes) || minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
	return `${Math.floor(minutes / (24 * 60))}d ago`;
}

/** One list row per session: the title as the label; turns, cost, age and id as the description (the id makes it searchable). */
export function sessionPickerItems(sessions: readonly SessionChoice[], now: number): SelectItem[] {
	return sessions.map((s) => ({
		value: s.id,
		label: oneLine(escapeControl(s.title), 60) || "(untitled)",
		description: `${s.turns} turn${s.turns === 1 ? "" : "s"} · ${usd(s.costUsd)} · ${ago(s.updatedAt, now)} · ${escapeControl(s.id)}`,
	}));
}

/** The picker screen: a heading, the searchable list (the settings screen's picker) and its key hint. */
class SessionPickerScreen implements Component {
	private readonly picker: PickerView;
	private readonly count: number;
	private readonly onCancel: () => void;

	constructor(picker: PickerView, count: number, onCancel: () => void) {
		this.picker = picker;
		this.count = count;
		this.onCancel = onCancel;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) return this.onCancel();
		this.picker.handleInput(data);
	}

	render(width: number): string[] {
		const heading = `${style.bold("Resume a session")} ${style.gray(`(${this.count} recent)`)}`;
		return fitLines([truncateToWidth(heading, width), ...this.picker.render(width), style.gray(truncateToWidth(this.picker.hint, width))], width);
	}

	invalidate(): void {}
}

export interface SessionPickerScreenOptions {
	sessions: readonly SessionChoice[];
	now: number;
	/** Terminal height, read on every render. */
	rows: () => number;
	onPick: (id: string) => void;
	onCancel: () => void;
}

/** The picker screen as a component, for `nexo --resume` and for `/resume` inside the chat. */
export function createSessionPickerScreen(options: SessionPickerScreenOptions): Component {
	const items = sessionPickerItems(options.sessions, options.now);
	const picker = new PickerView({
		title: "Resume a session",
		items,
		maxVisible: () => Math.max(3, Math.min(20, options.rows() - 9)),
		onPick: options.onPick,
		onCancel: options.onCancel,
		hint: "type to filter · ↑↓ move · enter resume · esc cancel",
		labelWidth: { min: 24, max: 48 },
	});
	return new SessionPickerScreen(picker, items.length, options.onCancel);
}

export interface SessionPickerOptions {
	sessions: readonly SessionChoice[];
	/** Defaults to a ProcessTerminal on stdin/stdout. */
	terminal?: Terminal;
	/** Aborting it cancels the picker. */
	signal?: AbortSignal;
	now?: () => number;
}

/**
 * Shows a searchable list of sessions for `nexo --resume`: type to filter by title or id, ↑↓ to move, enter to resume,
 * esc (with an empty filter) or ctrl-c to cancel. Resolves the picked session id, or null when cancelled. The terminal
 * is restored before it resolves.
 */
export async function runSessionPicker(options: SessionPickerOptions): Promise<string | null> {
	const terminal = options.terminal ?? new ProcessTerminal();
	const tui = new TuiMainScreen(terminal);
	let resolveDone: (id: string | null) => void = () => {};
	const done = new Promise<string | null>((resolve) => {
		resolveDone = resolve;
	});
	const screen = createSessionPickerScreen({
		sessions: options.sessions,
		now: (options.now ?? Date.now)(),
		rows: () => terminal.rows,
		onPick: (id) => resolveDone(id),
		onCancel: () => resolveDone(null),
	});
	const root = new SafeContainer();
	root.addChild(screen);
	tui.addChild(root);
	tui.setFocus(screen);
	const onAbort = () => resolveDone(null);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	startTui(tui);
	try {
		if (options.signal?.aborted) resolveDone(null);
		return await done;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		try {
			await terminal.drainInput(1000, 50);
		} finally {
			stopTui(tui);
		}
	}
}
