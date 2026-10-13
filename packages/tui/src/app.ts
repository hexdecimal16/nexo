import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	isKeyRelease,
	isKeyRepeat,
	Loader,
	matchesKey,
	ProcessTerminal,
	setCapabilityOverrides,
	type Terminal,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { type EngineEvent, listSessions, type RunResult, type Session, type Settings } from "@nexo/core";
import type { Effort } from "@nexo/router";
import type { Db, ScoreStatus, TranscriptLine } from "@nexo/store";
import { type ErrorPayload, toErrorPayload } from "@nexo/telemetry";
import type { Prompter } from "@nexo/tools";
import { createApprovalPrompter } from "./approvals.ts";
import { helpText, parseSlashCommand, SLASH_COMMANDS } from "./commands.ts";
import { Block, DynamicLine, SafeContainer, SafeMarkdown, SubagentLine, Ticker, ToolLine, ViewMode } from "./components.ts";
import { SettingsScreen, type SettingsScreenMode } from "./settings-screen.ts";
import { escapeControl, escapeControlKeepLines, formatError, oneLine, toolSummary, usd } from "./text.ts";
import { editorTheme, markdownTheme, shellBorder, style } from "./theme.ts";

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
	/** Clock for the double Ctrl-C window and the approval guard. */
	now?: () => number;
	/** How long exit waits for an aborted turn to finish before giving up on it (default 5000 ms). */
	exitTimeoutMs?: number;
}

const DOUBLE_CTRL_C_MS = 1000;
/** Last lines of a `!` command's output shown in the chat (the model gets more). */
const SHELL_SCREEN_LINES = 200;
/** Time given to paint the "opening…" footer before the synchronous session open blocks the loop (one render interval and a margin). */
const OPENING_PAINT_MS = 30;
const EXIT_TIMEOUT_MS = 5000;

/** Started TUIs, so `restoreTerminal` can stop them from a crash handler. */
const activeTuis = new Set<TuiMainScreen>();

function startTui(tui: TuiMainScreen): void {
	// Links render as "text (url)": an OSC 8 hyperlink would hide the real target behind the text.
	setCapabilityOverrides({ hyperlinks: false });
	activeTuis.add(tui);
	tui.start();
}

function stopTui(tui: TuiMainScreen): void {
	if (!activeTuis.delete(tui)) return;
	tui.stop();
}

/**
 * Restores the terminal (raw mode off, cursor shown, keyboard protocol popped) for every TUI this package started.
 * Synchronous and safe to call more than once; meant for the CLI's `exit`, `uncaughtException` and
 * `unhandledRejection` handlers. The package installs no process handlers itself.
 */
export function restoreTerminal(): void {
	for (const tui of [...activeTuis]) {
		activeTuis.delete(tui);
		try {
			tui.stop();
		} catch {
			// Best effort: the terminal may already be gone.
		}
	}
}
const TICK_MS = 80;

type Screen = "chat" | "approval" | "settings";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");
}

/**
 * `score 0.82 ✓` for the latest scoring round of a turn (mean of the scorers that answered), followed by `· N failed`
 * when some scorers failed; null when nothing scored it.
 */
export function scoreSummary(result: Pick<RunResult, "scores">): string | null {
	const scores = result.scores ?? [];
	if (scores.length === 0) return null;
	const answered = scores.filter((s) => s.status === "ok" && s.value !== null);
	if (answered.length === 0) return "score failed";
	const mean = answered.reduce((sum, s) => sum + (s.value ?? 0), 0) / answered.length;
	const failed = scores.filter((s) => s.status === "failed").length;
	// A scorer without a pass/fail verdict (passed null) neither passes nor fails the turn.
	const mark = answered.some((s) => s.passed === false) ? "✗" : answered.some((s) => s.passed === true) ? "✓" : "–";
	return `score ${mean.toFixed(2)} ${mark}${failed > 0 ? ` · ${failed} failed` : ""}`;
}

/** The verdict shown on a chat score line: `0.82 ✓`, `0.40 ✗`, `0.50 –` (no pass/fail verdict) or `failed`. */
export function scoreVerdict(score: { status: ScoreStatus; value: number | null; passed: boolean | null }): string {
	if (score.status === "failed") return style.red("failed");
	const value = score.value === null ? "–" : score.value.toFixed(2);
	return `${value} ${score.passed === null ? style.gray("–") : score.passed ? style.green("✓") : style.red("✗")}`;
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
	/** The running work is a `!` command, not a turn. */
	private runningShell = false;
	private turnCost = 0;
	private lastTurnCost = 0;
	/** Footer text for the latest turn's scores, e.g. `score 0.82 ✓`; null when nothing scored it. */
	private lastScore: string | null = null;
	private currentText: { component: SafeMarkdown; text: string } | null = null;
	private tools = new Map<string, ToolLine>();
	private readonly view = new ViewMode();
	private subagents = new Map<string, SubagentLine>();
	private tickTimer: NodeJS.Timeout | null = null;
	private loader: Loader | null = null;
	private lastCtrlC = Number.NEGATIVE_INFINITY;
	private defaultModel = "";
	private defaultEffort = "";

	private exiting = false;
	private resolveForce: () => void = () => {};
	private readonly forced = new Promise<void>((resolve) => {
		this.resolveForce = resolve;
	});
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
		this.editor.borderColor = (border) => (this.shellMode() ? shellBorder(border) : editorTheme.borderColor(border));
		this.editor.onSubmit = (text) => this.onSubmit(text);
		this.prompter = createApprovalPrompter({ show: (box) => this.showApproval(box) }, { now: this.now, redact: (text) => this.settings.redact(text) });
		const root = new SafeContainer();
		root.addChild(this.chat);
		root.addChild(this.status);
		root.addChild(this.slot);
		root.addChild(new DynamicLine(() => this.footerText()));
		this.tui.addChild(root);
		this.tui.addInputListener((data) => this.onKey(data));
	}

	async run(): Promise<number> {
		const onSignal = () => this.requestExit();
		this.options.signal?.addEventListener("abort", onSignal, { once: true });
		startTui(this.tui);
		try {
			if (this.options.signal?.aborted) return await this.shutdown(0);
			if (this.options.setup !== false && this.settings.setupStatus().needed) {
				const completed = await this.openSettings("setup");
				if (!completed || this.exiting) {
					this.say("setup cancelled; run nexo again to finish it");
					return await this.shutdown(1);
				}
			}
			// Paint the "opening…" footer before the (synchronous) session open.
			this.tui.requestRender();
			await new Promise<void>((resolve) => setTimeout(resolve, OPENING_PAINT_MS));
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

	/**
	 * Aborts the turn and waits for it to be saved, but at most `exitTimeoutMs`; a Ctrl-C while waiting stops waiting.
	 * The terminal is always restored. The session is closed unless its turn is still running (its lock is then
	 * released at process exit).
	 */
	private async shutdown(code: number): Promise<number> {
		this.exiting = true;
		this.turnAbort?.abort();
		let timer: NodeJS.Timeout | undefined;
		try {
			if (this.turnPromise) {
				this.say("stopping the turn… (ctrl-c to quit without waiting)");
				this.tui.requestRender();
				const deadline = new Promise<void>((resolve) => {
					timer = setTimeout(resolve, this.options.exitTimeoutMs ?? EXIT_TIMEOUT_MS);
				});
				await Promise.race([this.turnPromise, deadline, this.forced]);
			}
			this.stopTicker();
			this.tui.renderNow();
			await this.terminal.drainInput(1000, 50);
		} finally {
			if (timer) clearTimeout(timer);
			this.stopTicker();
			stopTui(this.tui);
		}
		if (this.session && !this.session.running) this.session.close();
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

	/** Swaps the editor for an approval box; the editor keeps its draft and comes back when the returned function runs. */
	private showApproval(box: Component): () => void {
		this.screen = "approval";
		this.slot.clear();
		this.slot.addChild(box);
		this.tui.setFocus(box);
		this.tui.requestRender();
		return () => {
			if (this.slot.children.includes(box)) this.showEditor();
		};
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
					if (block.type === "text" && block.text) this.add(new SafeMarkdown(escapeControlKeepLines(block.text), 0, 1, markdownTheme));
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

	/** The input is a `!` command: the editor border and the footer say so. */
	private shellMode(): boolean {
		return this.screen === "chat" && this.session !== null && this.editor.getText().trimStart().startsWith("!");
	}

	private footerText(): string {
		const session = this.session;
		if (!session) return style.gray(this.screen === "settings" ? "nexo · setup" : "nexo · opening…");
		if (this.shellMode()) return shellBorder(`! shell mode · output goes to the model with your next message · ${escapeControl(session.workspace)}`);
		const last = session.lastModel;
		const model = session.model ?? (last ? `${last.provider}/${last.id}` : this.defaultModel || "model ?");
		const effort = session.effort ?? last?.effort ?? (this.defaultEffort || "default effort");
		const turn = this.running ? this.turnCost : this.lastTurnCost;
		const spent = session.costUsd + (this.running ? this.turnCost : 0);
		const fraction = session.contextFraction;
		const ctx = fraction === null ? "ctx –" : `ctx ${Math.round(fraction * 100)}%`;
		const score = !this.running && this.lastScore ? [this.lastScore] : [];
		const parts = [escapeControl(model), escapeControl(effort), `turn ${usd(turn)}`, ...score, `session ${usd(spent)}/${usd(session.budgetUsd)}`, ctx];
		return style.gray(parts.join(" · ")) + (this.running ? style.cyan(" · running…") : "");
	}

	// Input

	private onKey(data: string): { consume: boolean } | undefined {
		// The kitty keyboard protocol also reports key releases; only presses count (the editor drops releases itself).
		if (isKeyRelease(data)) return undefined;
		if (this.exiting) {
			if (matchesKey(data, "ctrl+c")) this.resolveForce();
			return { consume: true };
		}
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
		if (matchesKey(data, "escape") && this.running && this.screen === "chat" && !this.editor.isShowingAutocomplete()) {
			this.turnAbort?.abort();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+o") && this.screen === "chat") {
			if (isKeyRepeat(data)) return { consume: true };
			this.view.verbose = !this.view.verbose;
			this.tui.requestRender(true);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d") && this.screen === "chat" && this.session && !this.running && this.editor.getText() === "") {
			this.requestExit();
			return { consume: true };
		}
		if (matchesKey(data, "enter") && this.screen === "chat" && this.editor.isShowingAutocomplete() && /^\/\S+\s/.test(this.editor.getText())) {
			// The editor only accepts an argument completion on Enter; press Enter again once it has, so `/effort high⏎` submits.
			queueMicrotask(() => {
				if (!this.editor.isShowingAutocomplete()) this.editor.handleInput(data);
			});
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
			this.say(`A ${this.runningShell ? "command" : "turn"} is running — press esc to stop it, or wait for it to finish`);
			return;
		}
		if (text.startsWith("!")) {
			const shell = text.slice(1).trim();
			if (!shell) {
				this.say("Type a command after !, e.g. !git status");
				return;
			}
			this.add(new Block(escapeControlKeepLines(shell), style.dim, "! "));
			this.turnPromise = this.runShell(this.session, shell).finally(() => {
				this.turnPromise = null;
			});
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
		this.lastScore = null;
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
			this.lastScore = scoreSummary(result);
			if (result.status === "aborted") this.say("interrupted");
			else if (result.error) this.sayError(result.error);
			else if (result.status !== "succeeded") this.say(`turn ended: ${result.status}`);
		}
		this.tui.requestRender();
	}

	/** Runs a `!` command like a turn (esc and ctrl-c stop it), then shows its output and how it ended. */
	private async runShell(session: Session, command: string): Promise<void> {
		const abort = new AbortController();
		this.turnAbort = abort;
		this.running = true;
		this.runningShell = true;
		this.startTicker();
		try {
			const result = await session.shell(command, { signal: abort.signal });
			const lines = result.output.replace(/\n$/, "").split("\n");
			const hidden = lines.length - SHELL_SCREEN_LINES;
			const shown = hidden > 0 ? [`… ${hidden} earlier lines not shown`, ...lines.slice(-SHELL_SCREEN_LINES)] : lines;
			if (result.output) this.add(new Block(escapeControlKeepLines(shown.join("\n")), (t) => t, "  "));
			const ending = { exited: `exit code ${result.exitCode}`, timeout: "timed out", aborted: "stopped", failed: "failed to start" }[result.ended];
			this.say(`${ending}${result.truncated ? " · output truncated" : ""}`);
		} catch (error) {
			this.sayError(toErrorPayload(error));
		} finally {
			this.running = false;
			this.runningShell = false;
			this.turnAbort = null;
			this.stopTicker();
		}
		this.tui.requestRender();
	}

	private onEvent(event: EngineEvent): void {
		switch (event.type) {
			case "text_delta": {
				if (event.depth !== 0) return;
				if (!this.currentText) {
					const component = new SafeMarkdown("", 0, 1, markdownTheme);
					this.currentText = { component, text: "" };
					this.chat.addChild(component);
				}
				this.currentText.text += event.delta;
				this.currentText.component.setText(escapeControlKeepLines(this.settings.redact(this.currentText.text)));
				break;
			}
			case "tool_start": {
				if (event.depth !== 0) return;
				this.currentText = null;
				const line = new ToolLine(toolSummary(event.toolName, event.args), toolSummary(event.toolName, event.args, Number.POSITIVE_INFINITY), this.ticker, this.view);
				this.tools.set(event.toolCallId, line);
				this.chat.addChild(line);
				break;
			}
			case "tool_end": {
				if (event.depth !== 0) return;
				this.tools.get(event.toolCallId)?.finish(event.isError, event.durationMs, event.output);
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
			case "escalation": {
				if (event.depth !== 0) return;
				this.currentText = null;
				const why = `${event.trigger}: ${escapeControl(oneLine(event.reason, 120))}`;
				this.chat.addChild(
					event.applied
						? new Block(`↑ escalated to ${escapeControl(event.model)} — ${why}`, style.yellow, "  ")
						: new Block(`escalation suppressed (${escapeControl(event.blockedBy ?? "?")}) — ${why}`, style.gray, "  "),
				);
				break;
			}
			case "escalation_failed": {
				if (event.depth !== 0) return;
				this.currentText = null;
				const error = `[${escapeControl(oneLine(event.error.code, 40))}] ${escapeControl(oneLine(event.error.message, 120))}`;
				this.chat.addChild(new Block(`✗ s2 continuation failed ${error}; kept the previous answer`, style.red, "  "));
				break;
			}
			case "score": {
				if (event.depth !== 0) return;
				this.currentText = null;
				this.chat.addChild(new Block(`score ${escapeControl(oneLine(event.scorer, 60))}: ${scoreVerdict(event)}`, style.gray, "  "));
				break;
			}
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
					if (!args) this.say(`model: ${escapeControl(session.model ?? `${this.defaultModel} (default)`)}`);
					else {
						session.setModel(args === "default" ? null : args);
						this.say(session.model ? `model set to ${escapeControl(session.model)} for this session` : "model override cleared");
					}
					break;
				case "effort":
					if (!args) this.say(`effort: ${escapeControl(session.effort ?? `${this.defaultEffort || "default"} (default)`)}`);
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
						try {
							session.refreshConfig();
						} catch (error) {
							this.sayError(toErrorPayload(error));
						}
						this.tui.requestRender();
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
			const title = r.title ? escapeControl(oneLine(r.title, 40)) : "(untitled)";
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
	const root = new SafeContainer();
	root.addChild(screen);
	tui.addChild(root);
	tui.setFocus(screen);
	const onAbort = () => resolveDone(false);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	startTui(tui);
	try {
		if (options.signal?.aborted) resolveDone(false);
		const completed = await done;
		return { completed };
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		try {
			await terminal.drainInput(1000, 50);
		} finally {
			stopTui(tui);
		}
	}
}
