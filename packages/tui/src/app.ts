import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	type Terminal,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { type EngineEvent, listSessions, type RunResult, type Session, type Settings } from "@nexo/core";
import type { Effort } from "@nexo/router";
import type { Db, TranscriptLine } from "@nexo/store";
import { type ErrorPayload, toErrorPayload } from "@nexo/telemetry";
import type { Prompter } from "@nexo/tools";
import { createOverlayPrompter } from "./approvals.ts";
import { helpText, parseSlashCommand, SLASH_COMMANDS } from "./commands.ts";
import { Block, DynamicLine, SubagentLine, Ticker, ToolLine } from "./components.ts";
import { SettingsScreen, type SettingsScreenMode } from "./settings-screen.ts";
import { escapeControl, escapeControlKeepLines, formatError, oneLine, toolSummary, usd } from "./text.ts";
import { editorTheme, markdownTheme, style } from "./theme.ts";

export interface InteractiveOptions {
	/**
	 * Creates or resumes the session. Called once, after first-run setup, with the TUI's approval prompter, which must
	 * be passed as `SessionDeps.prompter`.
	 */
	openSession: (prompter: Prompter) => Session;
	settings: Settings;
	/** For `/sessions`. */
	db: Db;
	/** Defaults to a ProcessTerminal on stdin/stdout. */
	terminal?: Terminal;
	/** Aborting it (e.g. on SIGTERM) aborts the running turn, waits for it to be saved, and exits. */
	signal?: AbortSignal;
	/** Run first-run setup when `settings.setupStatus().needed` (default true). */
	setup?: boolean;
	/** Clock for the double Ctrl-C window. */
	now?: () => number;
}

const DOUBLE_CTRL_C_MS = 1000;
const TICK_MS = 80;

type Screen = "chat" | "settings";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");
}

/** Runs the chat UI: the conversation, the editor, the footer, approvals, slash commands and the settings screen. */
class InteractiveApp {
	private readonly options: InteractiveOptions;
	private readonly settings: Settings;
	private readonly terminal: Terminal;
	private readonly tui: TuiMainScreen;
	private readonly chat = new Container();
	private readonly status = new Container();
	private readonly slot = new Container();
	private readonly editor: Editor;
	private readonly ticker = new Ticker();
	private readonly now: () => number;
	private readonly prompter: Prompter;
	private session: Session | null = null;
	private screen: Screen = "chat";

	private running = false;
	private turnAbort: AbortController | null = null;
	private turnPromise: Promise<void> | null = null;
	private turnCost = 0;
	private lastTurnCost = 0;
	private currentText: { component: Markdown; text: string } | null = null;
	private tools = new Map<string, ToolLine>();
	private subagents = new Map<string, SubagentLine>();
	private tickTimer: NodeJS.Timeout | null = null;
	private loader: Loader | null = null;
	private lastCtrlC = Number.NEGATIVE_INFINITY;
	private defaultModel = "";
	private defaultEffort = "";

	private exiting = false;
	private resolveExit: () => void = () => {};
	private readonly exitRequested = new Promise<void>((resolve) => {
		this.resolveExit = resolve;
	});

	constructor(options: InteractiveOptions) {
		this.options = options;
		this.settings = options.settings;
		this.terminal = options.terminal ?? new ProcessTerminal();
		this.now = options.now ?? Date.now;
		this.tui = new TuiMainScreen(this.terminal);
		this.editor = new Editor(this.tui, editorTheme);
		this.editor.onSubmit = (text) => this.onSubmit(text);
		this.prompter = createOverlayPrompter(this.tui);
		this.tui.addChild(this.chat);
		this.tui.addChild(this.status);
		this.tui.addChild(this.slot);
		this.tui.addChild(new DynamicLine(() => this.footerText()));
		this.tui.addInputListener((data) => this.onKey(data));
	}

	async run(): Promise<number> {
		const onSignal = () => this.requestExit();
		this.options.signal?.addEventListener("abort", onSignal, { once: true });
		this.tui.start();
		try {
			if (this.options.signal?.aborted) return await this.shutdown(0);
			if (this.options.setup !== false && this.settings.setupStatus().needed) {
				const completed = await this.openSettings("setup");
				if (!completed || this.exiting) {
					this.say("setup cancelled; run nexo again to finish it");
					return await this.shutdown(1);
				}
			}
			try {
				this.session = this.options.openSession(this.prompter);
			} catch (error) {
				await this.shutdown(1);
				throw error;
			}
			this.refreshDefaults();
			this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...SLASH_COMMANDS], this.session.cwd));
			this.renderHeader(this.session);
			this.showEditor();
			await this.exitRequested;
			return await this.shutdown(0);
		} finally {
			this.options.signal?.removeEventListener("abort", onSignal);
		}
	}

	// Lifecycle

	private requestExit(): void {
		if (this.exiting) return;
		this.exiting = true;
		this.turnAbort?.abort();
		this.resolveExit();
	}

	private async shutdown(code: number): Promise<number> {
		this.exiting = true;
		this.turnAbort?.abort();
		if (this.turnPromise) await this.turnPromise;
		this.stopTicker();
		this.tui.renderNow();
		await this.terminal.drainInput(1000, 50);
		this.tui.stop();
		this.session?.close();
		return code;
	}

	// Layout helpers

	private showEditor(): void {
		this.screen = "chat";
		this.slot.clear();
		this.slot.addChild(this.editor);
		this.tui.setFocus(this.editor);
		this.tui.requestRender();
	}

	private add(component: Component): void {
		this.chat.addChild(component);
		this.tui.requestRender();
	}

	private say(text: string): void {
		this.add(new Block(escapeControlKeepLines(text), style.gray, "  "));
	}

	private sayError(error: Pick<ErrorPayload, "code" | "message" | "hint">): void {
		this.add(new Block(formatError(error), style.red, "  "));
	}

	private renderHeader(session: Session): void {
		const resumed = session.turns > 0;
		this.add(
			new Block(
				`${style.bold("nexo")} ${style.gray(`session ${session.id}${session.title ? ` · ${escapeControl(oneLine(session.title, 60))}` : ""} · ${escapeControl(session.workspace)}`)}`,
			),
		);
		if (resumed) this.renderTranscript(session.transcript());
		this.say(`${resumed ? `resumed after ${session.turns} turn${session.turns === 1 ? "" : "s"} · ` : ""}/help for commands · esc or ctrl-c stops a turn · ctrl-d quits`);
	}

	/** Replays a resumed conversation: user messages, assistant text and tool calls. */
	private renderTranscript(lines: readonly TranscriptLine[]): void {
		for (const line of lines) {
			if (line.type === "compaction") {
				this.say(line.summary ? "── earlier turns summarized ──" : "── conversation cleared ──");
				continue;
			}
			const message = line.message as { role?: string; content?: unknown };
			if (message.role === "user") {
				this.add(new Block(escapeControlKeepLines(textOf(message.content)), style.dim, "› "));
			} else if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content as { type?: string; text?: string; name?: string; arguments?: unknown }[]) {
					if (block.type === "text" && block.text) this.add(new Markdown(escapeControlKeepLines(block.text), 0, 1, markdownTheme));
					else if (block.type === "toolCall") this.add(new Block(`● ${toolSummary(block.name ?? "tool", block.arguments)}`, style.gray));
				}
			}
		}
	}

	private refreshDefaults(): void {
		try {
			const { config } = this.settings.loadConfig();
			this.defaultModel = `${config.models.s1.provider}/${config.models.s1.id}`;
			this.defaultEffort = (config.models.s1 as { effort?: Effort }).effort ?? "";
		} catch {
			this.defaultModel = "";
			this.defaultEffort = "";
		}
	}

	private footerText(): string {
		const session = this.session;
		if (!session) return style.gray("nexo · setup");
		const last = session.lastModel;
		const model = session.model ?? (last ? `${last.provider}/${last.id}` : this.defaultModel || "model ?");
		const effort = session.effort ?? last?.effort ?? (this.defaultEffort || "default effort");
		const turn = this.running ? this.turnCost : this.lastTurnCost;
		const spent = session.costUsd + (this.running ? this.turnCost : 0);
		const fraction = session.contextFraction;
		const ctx = fraction === null ? "ctx –" : `ctx ${Math.round(fraction * 100)}%`;
		const parts = [escapeControl(model), effort, `turn ${usd(turn)}`, `session ${usd(spent)}/${usd(session.budgetUsd)}`, ctx];
		return style.gray(parts.join(" · ")) + (this.running ? style.cyan(" · running…") : "");
	}

	// Input

	private onKey(data: string): { consume: boolean } | undefined {
		if (this.exiting) return { consume: true };
		if (matchesKey(data, "ctrl+c")) {
			if (this.running) {
				this.turnAbort?.abort();
				return { consume: true };
			}
			if (this.screen !== "chat" || !this.session) return undefined;
			const now = this.now();
			if (now - this.lastCtrlC <= DOUBLE_CTRL_C_MS && this.editor.getText() === "") {
				this.requestExit();
			} else {
				this.editor.setText("");
				this.lastCtrlC = now;
				this.tui.requestRender();
			}
			return { consume: true };
		}
		if (matchesKey(data, "escape") && this.running && !this.tui.hasOverlay() && !this.editor.isShowingAutocomplete()) {
			this.turnAbort?.abort();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d") && this.screen === "chat" && this.session && !this.running && this.editor.getText() === "") {
			this.requestExit();
			return { consume: true };
		}
		return undefined;
	}

	private onSubmit(raw: string): void {
		const text = raw.trim();
		if (!text || !this.session) return;
		this.editor.addToHistory(text);
		const command = parseSlashCommand(text);
		if (command) {
			this.runCommand(command.name, command.args);
			return;
		}
		if (this.running) {
			this.say("A turn is running — press esc to stop it, or wait for it to finish");
			return;
		}
		this.add(new Block(escapeControlKeepLines(text), style.dim, "› "));
		this.turnPromise = this.runTurn(this.session, text).finally(() => {
			this.turnPromise = null;
		});
	}

	// Turns

	private async runTurn(session: Session, text: string): Promise<void> {
		const abort = new AbortController();
		this.turnAbort = abort;
		this.running = true;
		this.turnCost = 0;
		this.currentText = null;
		this.tools.clear();
		this.subagents.clear();
		this.startTicker();
		let result: RunResult | null = null;
		try {
			result = await session.turn(text, { signal: abort.signal, onEvent: (event) => this.onEvent(event) });
		} catch (error) {
			this.sayError(toErrorPayload(error));
		} finally {
			this.running = false;
			this.turnAbort = null;
			this.stopTicker();
			for (const line of this.tools.values()) line.interrupt();
			for (const line of this.subagents.values()) line.interrupt();
			this.currentText = null;
		}
		if (result) {
			this.lastTurnCost = result.costUsd;
			if (result.status === "aborted") this.say("interrupted");
			else if (result.error) this.sayError(result.error);
			else if (result.status !== "succeeded") this.say(`turn ended: ${result.status}`);
		}
		this.tui.requestRender();
	}

	private onEvent(event: EngineEvent): void {
		switch (event.type) {
			case "text_delta": {
				if (event.depth !== 0) return;
				if (!this.currentText) {
					const component = new Markdown("", 0, 1, markdownTheme);
					this.currentText = { component, text: "" };
					this.chat.addChild(component);
				}
				this.currentText.text += event.delta;
				this.currentText.component.setText(escapeControlKeepLines(this.currentText.text));
				break;
			}
			case "tool_start": {
				if (event.depth !== 0) return;
				this.currentText = null;
				const line = new ToolLine(toolSummary(event.toolName, event.args), this.ticker);
				this.tools.set(event.toolCallId, line);
				this.chat.addChild(line);
				break;
			}
			case "tool_end": {
				if (event.depth !== 0) return;
				this.tools.get(event.toolCallId)?.finish(event.isError, event.durationMs, event.preview);
				this.tools.delete(event.toolCallId);
				break;
			}
			case "run_start": {
				if (event.depth === 0) return;
				const line = new SubagentLine(escapeControl(oneLine(event.instruction, 70)), event.depth, this.ticker);
				this.subagents.set(event.runId, line);
				this.chat.addChild(line);
				break;
			}
			case "run_end": {
				if (event.depth === 0) return;
				this.subagents.get(event.runId)?.finish(event.status, event.costUsd);
				this.subagents.delete(event.runId);
				break;
			}
			case "llm_end":
				this.turnCost += event.costUsd;
				break;
			case "compaction_start":
				this.currentText = null;
				this.chat.addChild(new Block("compacting earlier turns…", style.gray, "  "));
				break;
			case "compaction_end":
				this.chat.addChild(
					new Block(event.ok ? `earlier turns compacted (${usd(event.costUsd)})` : "compaction failed; continuing with the full history", style.gray, "  "),
				);
				break;
		}
		this.tui.requestRender();
	}

	private startTicker(): void {
		this.stopTicker();
		this.loader = new Loader(this.tui, style.cyan, style.gray, "working… (esc to stop)");
		this.status.addChild(this.loader);
		this.tickTimer = setInterval(() => {
			this.ticker.frame++;
			this.tui.requestRender();
		}, TICK_MS);
	}

	private stopTicker(): void {
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.tickTimer = null;
		this.loader?.stop();
		this.loader = null;
		this.status.clear();
	}

	// Slash commands

	private runCommand(name: string, args: string): void {
		const session = this.session;
		if (!session) return;
		const idleOnly = !["help", "cost", "sessions", "exit"].includes(name);
		if (idleOnly && this.running && SLASH_COMMANDS.some((c) => c.name === name)) {
			this.say(`A turn is running — press esc to stop it before /${name}`);
			return;
		}
		try {
			switch (name) {
				case "help":
					this.say(helpText());
					break;
				case "done":
					session.review("done");
					this.say("marked the last turn done");
					break;
				case "notdone":
					session.review("not_done", args || undefined);
					this.say(`marked the last turn not done${args ? " with your comment" : ""}`);
					break;
				case "cost":
					this.say(
						`session ${usd(session.costUsd)} of ${usd(session.budgetUsd)} (${usd(session.remainingUsd)} left) · last turn ${usd(this.lastTurnCost)} · ${session.turns} turn${session.turns === 1 ? "" : "s"}`,
					);
					break;
				case "budget": {
					const value = args.replace(/^\$/, "");
					session.setBudget(value === "" ? Number.NaN : Number(value));
					this.say(`session budget set to ${usd(session.budgetUsd)}`);
					break;
				}
				case "model":
					if (!args) this.say(`model: ${session.model ?? `${this.defaultModel} (default)`}`);
					else {
						session.setModel(args === "default" ? null : args);
						this.say(session.model ? `model set to ${session.model} for this session` : "model override cleared");
					}
					break;
				case "effort":
					if (!args) this.say(`effort: ${session.effort ?? `${this.defaultEffort || "default"} (default)`}`);
					else {
						session.setEffort(args === "default" ? null : (args as Effort));
						this.say(session.effort ? `effort set to ${session.effort} for this session` : "effort override cleared");
					}
					break;
				case "compact":
					session.compact();
					this.say("older turns will be summarized at the start of the next turn");
					break;
				case "clear":
					session.clear();
					this.say("── conversation cleared ── (same session; earlier turns stay in its history)");
					break;
				case "sessions":
					this.say(this.sessionsText(session));
					break;
				case "settings":
					void this.openSettings("settings").then(() => {
						this.refreshDefaults();
						this.say("settings closed; changes apply from the next turn");
					});
					break;
				case "exit":
					this.requestExit();
					break;
				default:
					this.sayError({ code: "INVALID_REQUEST", message: `Unknown command /${name}`, hint: "Type /help for the list" });
			}
		} catch (error) {
			this.sayError(toErrorPayload(error));
		}
		this.tui.requestRender();
	}

	private sessionsText(current: Session): string {
		const rows = listSessions(this.options.db, { limit: 10 });
		if (rows.length === 0) return "no sessions yet";
		const lines = rows.map((r) => {
			const mark = r.id === current.id ? "*" : " ";
			const title = r.title ? oneLine(r.title, 40) : "(untitled)";
			return `${mark} ${r.id}  ${title}  ${r.turns} turn${r.turns === 1 ? "" : "s"}  ${usd(r.costUsd)}  ${r.updatedAt.slice(0, 16).replace("T", " ")}`;
		});
		lines.push("resume one later with: nexo --resume <id>");
		return lines.join("\n");
	}

	// Settings

	private openSettings(mode: SettingsScreenMode): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.screen = "settings";
			const screen = new SettingsScreen({
				settings: this.settings,
				mode,
				rows: () => this.terminal.rows,
				requestRender: () => this.tui.requestRender(),
				onClose: (completed) => {
					if (this.session) this.showEditor();
					else {
						this.slot.clear();
						this.screen = "chat";
					}
					resolve(completed);
				},
			});
			this.slot.clear();
			this.slot.addChild(screen);
			this.tui.setFocus(screen);
			this.tui.requestRender();
			void this.exitRequested.then(() => resolve(false));
		});
	}
}

/**
 * Runs an interactive session in the terminal until the user quits. Returns the exit code: 0 after a normal exit, 1
 * when first-run setup was cancelled. The terminal is restored and the session closed before it returns. Errors
 * thrown by `openSession` are rethrown after the terminal is restored.
 */
export function runInteractive(options: InteractiveOptions): Promise<number> {
	return new InteractiveApp(options).run();
}

export interface SettingsScreenRunOptions {
	settings: Settings;
	terminal?: Terminal;
	/** "settings" (default): the full settings screen; "setup": the first-run model and key steps. */
	mode?: SettingsScreenMode;
	/** Aborting it closes the screen. */
	signal?: AbortSignal;
}

export interface SettingsScreenResult {
	/** False when setup was cancelled or could not run. */
	completed: boolean;
	/** Set when the config cannot be read (setup mode); nothing was shown. */
	error?: ErrorPayload;
}

/** Runs the settings screen (or first-run setup) on its own, for `nexo settings` and first-run outside a session. */
export async function runSettingsScreen(options: SettingsScreenRunOptions): Promise<SettingsScreenResult> {
	const mode = options.mode ?? "settings";
	if (mode === "setup") {
		const status = options.settings.setupStatus();
		if (status.error) return { completed: false, error: status.error };
		if (!status.needed) return { completed: true };
	}
	const terminal = options.terminal ?? new ProcessTerminal();
	const tui = new TuiMainScreen(terminal);
	let resolveDone: (completed: boolean) => void = () => {};
	const done = new Promise<boolean>((resolve) => {
		resolveDone = resolve;
	});
	const screen = new SettingsScreen({
		settings: options.settings,
		mode,
		rows: () => terminal.rows,
		requestRender: () => tui.requestRender(),
		onClose: (completed) => resolveDone(completed),
	});
	tui.addChild(screen);
	tui.setFocus(screen);
	const onAbort = () => resolveDone(false);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	tui.start();
	try {
		if (options.signal?.aborted) resolveDone(false);
		const completed = await done;
		return { completed };
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		await terminal.drainInput(1000, 50);
		tui.stop();
	}
}
