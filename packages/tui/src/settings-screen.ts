import { type Component, fuzzyFilter, Input, matchesKey, type SelectItem, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import { type KeyStatus, keyStatusLabel, type SettingView, type Settings } from "@nexo/core";
import { toErrorPayload } from "@nexo/telemetry";
import { MaskedInput } from "./components.ts";
import { escapeControl, formatError } from "./text.ts";
import { selectListTheme, style } from "./theme.ts";

export type SettingsScreenMode = "settings" | "setup";

const RESET = "\u0000reset";
const BACK = "\u0000back";

interface View extends Component {
	readonly title: string;
	readonly hint: string;
	handleInput(data: string): void;
}

/** A list filtered by typing. With `freeText`, Enter on a filter that matches nothing picks the filter text. */
class PickerView implements View {
	readonly title: string;
	readonly hint: string;
	private readonly items: SelectItem[];
	private readonly freeText: boolean;
	private readonly maxVisible: () => number;
	private readonly onPick: (value: string) => void;
	private readonly onCancel: () => void;
	private filter = "";
	private list: SelectList;
	private filtered: SelectItem[];

	constructor(options: {
		title: string;
		items: SelectItem[];
		freeText?: boolean;
		maxVisible: () => number;
		onPick: (value: string) => void;
		onCancel: () => void;
		hint?: string;
	}) {
		this.title = options.title;
		this.items = options.items;
		this.freeText = options.freeText ?? false;
		this.maxVisible = options.maxVisible;
		this.onPick = options.onPick;
		this.onCancel = options.onCancel;
		this.hint = options.hint ?? "type to filter · ↑↓ move · enter select · esc back";
		this.filtered = this.items;
		this.list = this.buildList();
	}

	private buildList(): SelectList {
		const items = this.filtered.length > 0 ? this.filtered : [];
		const list = new SelectList(items, Math.max(3, this.maxVisible()), selectListTheme, { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 32 });
		list.onSelect = (item) => this.onPick(item.value);
		list.onCancel = () => this.onCancel();
		return list;
	}

	private refilter(): void {
		this.filtered = fuzzyFilter(this.items, this.filter, (item) => `${item.label} ${item.value.startsWith("\u0000") ? "" : item.value}`);
		this.list = this.buildList();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "backspace")) {
			if (this.filter.length > 0) {
				this.filter = this.filter.slice(0, -1);
				this.refilter();
			}
			return;
		}
		if (matchesKey(data, "enter") && this.filtered.length === 0) {
			if (this.freeText && this.filter.trim()) this.onPick(this.filter.trim());
			return;
		}
		if (matchesKey(data, "escape") && this.filter.length > 0) {
			this.filter = "";
			this.refilter();
			return;
		}
		if (!data.startsWith("\x1b") && !/[\u0000-\u001f\u007f]/.test(data) && data.length > 0) {
			this.filter += data;
			this.refilter();
			return;
		}
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		const filterLine = this.filter ? `${style.gray("filter:")} ${escapeControl(this.filter)}` : style.gray("filter: (type to filter)");
		const lines = [truncateToWidth(filterLine, width)];
		if (this.filtered.length === 0) {
			lines.push(style.gray(this.freeText && this.filter.trim() ? `  enter uses "${escapeControl(this.filter.trim())}"` : "  no matches"));
		} else {
			lines.push(...this.list.render(width));
		}
		return lines;
	}

	invalidate(): void {}
}

/** A single-line text entry (plain or masked). */
class EntryView implements View {
	readonly title: string;
	readonly hint: string;
	private readonly input: Input | MaskedInput;
	constructor(options: { title: string; hint: string; input: Input | MaskedInput }) {
		this.title = options.title;
		this.hint = options.hint;
		this.input = options.input;
		this.input.focused = true;
	}
	handleInput(data: string): void {
		this.input.handleInput(data);
	}
	render(width: number): string[] {
		return this.input.render(width);
	}
	invalidate(): void {}
}

function valueText(view: SettingView): string {
	return view.value === null ? "unset" : String(view.value);
}

function settingDescription(view: SettingView): string {
	const source = view.source === "unset" ? "" : ` (${view.source})`;
	const notice = view.notice ? ` · ${view.notice}` : "";
	return escapeControl(`${valueText(view)}${source}${notice}`);
}

export interface SettingsScreenOptions {
	settings: Settings;
	mode: SettingsScreenMode;
	/** Rows available for lists. */
	rows: () => number;
	requestRender: () => void;
	/** `completed` is false when first-run setup was cancelled. */
	onClose: (completed: boolean) => void;
}

/**
 * The settings screen: provider key status and masked key entry, the editable settings with their source and
 * project-override notice, and the first-run setup flow. All reads and writes go through the core `Settings` service.
 */
export class SettingsScreen implements Component {
	private readonly settings: Settings;
	private readonly mode: SettingsScreenMode;
	private readonly rows: () => number;
	private readonly requestRender: () => void;
	private readonly onClose: (completed: boolean) => void;
	private view: View;
	private status: { kind: "info" | "error"; text: string } | null = null;
	private intro: string | null = null;
	private closed = false;

	constructor(options: SettingsScreenOptions) {
		this.settings = options.settings;
		this.mode = options.mode;
		this.rows = options.rows;
		this.requestRender = options.requestRender;
		this.onClose = options.onClose;
		if (this.mode === "setup") {
			this.intro = "Welcome to nexo. Pick the two models it works with (s1 for most work, s2 for harder steps) and enter their provider's API key.";
			this.view = this.nextSetupStep() ?? this.menuView();
		} else {
			this.view = this.menuView();
		}
	}

	private listRows(): number {
		return Math.max(3, Math.min(20, this.rows() - 10));
	}

	private show(view: View): void {
		this.view = view;
		this.requestRender();
	}

	private setError(error: unknown, secret?: string): void {
		let text = formatError(toErrorPayload(error));
		if (secret && secret.length >= 4) text = text.split(secret).join("•••");
		this.status = { kind: "error", text };
		this.requestRender();
	}

	private setInfo(text: string): void {
		this.status = { kind: "info", text: escapeControl(text) };
		this.requestRender();
	}

	private close(completed: boolean): void {
		if (this.closed) return;
		this.closed = true;
		this.onClose(completed);
	}

	// Menu

	private menuView(): View {
		let keys: KeyStatus[] = [];
		let views: SettingView[] = [];
		try {
			keys = this.settings.keyProviders();
			views = this.settings.settings();
		} catch (error) {
			this.setError(error);
		}
		const items: SelectItem[] = [
			...keys.map((k) => ({ value: `key:${k.provider}`, label: `${k.provider} key`, description: escapeControl(keyStatusLabel(k)) })),
			...views.map((v) => ({ value: `set:${v.key}`, label: v.label, description: settingDescription(v) })),
		];
		return new PickerView({
			title: "Settings",
			items,
			maxVisible: () => this.listRows(),
			hint: "type to filter · ↑↓ move · enter edit · esc close",
			onPick: (value) => {
				this.status = null;
				if (value.startsWith("key:")) this.show(this.keyActionsView(value.slice(4)));
				else this.editSetting(value.slice(4));
			},
			onCancel: () => this.close(true),
		});
	}

	private backToMenu(): void {
		this.show(this.menuView());
	}

	// Keys

	private keyActionsView(provider: string): View {
		let status: KeyStatus;
		try {
			status = this.settings.keyStatus(provider);
		} catch (error) {
			this.setError(error);
			return this.menuView();
		}
		const items: SelectItem[] = [{ value: "set", label: "Set key", description: "masked entry; stored in credentials.json (mode 600)" }];
		if (status.inFile) items.push({ value: "remove", label: "Remove key", description: "delete it from credentials.json" });
		items.push({ value: BACK, label: "Back" });
		return new PickerView({
			title: `${provider} key: ${keyStatusLabel(status)}${status.state === "env" && status.envVar ? ` (${status.envVar} wins over the file)` : ""}`,
			items,
			maxVisible: () => 3,
			onPick: (value) => {
				if (value === "set") this.show(this.keyEntryView(provider, () => this.backToMenu(), () => this.backToMenu()));
				else if (value === "remove") {
					try {
						const after = this.settings.removeKey(provider);
						this.setInfo(`${provider} key removed; now ${keyStatusLabel(after)}`);
					} catch (error) {
						this.setError(error);
					}
					this.backToMenu();
				} else this.backToMenu();
			},
			onCancel: () => this.backToMenu(),
		});
	}

	private keyEntryView(provider: string, onDone: () => void, onCancel: () => void): View {
		const input = new MaskedInput(style.gray("key> "));
		input.onSubmit = (value) => {
			if (!value.trim()) {
				this.setInfo("No key entered");
				return;
			}
			try {
				const status = this.settings.setKey(provider, value);
				this.setInfo(`${provider} key ${keyStatusLabel(status)}`);
				onDone();
			} catch (error) {
				this.setError(error, value.trim());
			}
		};
		input.onCancel = onCancel;
		return new EntryView({
			title: `API key for ${provider} (input hidden)`,
			hint: "paste or type the key · enter save · esc cancel",
			input,
		});
	}

	// Settings

	private editSetting(key: string): void {
		let view: SettingView;
		try {
			view = this.settings.getSetting(key);
		} catch (error) {
			this.setError(error);
			return;
		}
		const type = view.type;
		if (type.kind === "number") this.show(this.numberView(view));
		else if (type.kind === "enum") this.show(this.enumView(view, type.values));
		else this.show(this.modelView(view, () => this.backToMenu(), () => this.backToMenu(), true));
	}

	private apply(write: () => SettingView): boolean {
		try {
			const after = write();
			this.setInfo(`${after.label} = ${valueText(after)}${after.notice ? ` (${after.notice})` : ""}`);
			return true;
		} catch (error) {
			this.setError(error);
			return false;
		}
	}

	private numberView(view: SettingView): View {
		const input = new Input({ prompt: style.gray("> ") });
		input.setValue(view.userValue === null ? "" : String(view.userValue));
		input.onSubmit = (raw) => {
			const ok = raw.trim() === "" ? this.apply(() => this.settings.resetSetting(view.key)) : this.apply(() => this.settings.setSettingFromString(view.key, raw.trim()));
			if (ok) this.backToMenu();
		};
		input.onEscape = () => this.backToMenu();
		return new EntryView({
			title: `${view.label}: ${escapeControl(view.description)} (now ${settingDescription(view)})`,
			hint: "enter save · empty resets to the default · esc back",
			input,
		});
	}

	private enumView(view: SettingView, values: readonly string[]): View {
		const items: SelectItem[] = values.map((v) => ({ value: v, label: v, description: v === view.value ? "current" : undefined }));
		items.push({ value: RESET, label: "reset to default", description: "remove it from your user config" });
		return new PickerView({
			title: `${view.label}: ${escapeControl(view.description)}`,
			items,
			maxVisible: () => this.listRows(),
			onPick: (value) => {
				const ok = value === RESET ? this.apply(() => this.settings.resetSetting(view.key)) : this.apply(() => this.settings.setSetting(view.key, value));
				if (ok) this.backToMenu();
			},
			onCancel: () => this.backToMenu(),
		});
	}

	private modelItems(withReset: boolean): SelectItem[] {
		const items: SelectItem[] = [];
		try {
			for (const provider of this.settings.modelCatalog()) {
				for (const model of provider.models) {
					items.push({ value: model.ref, label: model.ref, description: `${model.name} · ${Math.round(model.contextWindow / 1000)}k ctx` });
				}
			}
		} catch (error) {
			this.setError(error);
		}
		if (withReset) items.push({ value: RESET, label: "reset to default", description: "remove it from your user config" });
		return items;
	}

	private modelView(view: SettingView, onDone: () => void, onCancel: () => void, withReset: boolean): View {
		return new PickerView({
			title: `${this.mode === "setup" ? `Choose ${view.label.toLowerCase()}` : view.label}: ${escapeControl(view.description)}`,
			items: this.modelItems(withReset),
			freeText: true,
			maxVisible: () => this.listRows(),
			hint: "type to filter or enter provider/model-id · enter select · esc back",
			onPick: (value) => {
				const ok = value === RESET ? this.apply(() => this.settings.resetSetting(view.key)) : this.apply(() => this.settings.setSetting(view.key, value));
				if (ok) onDone();
			},
			onCancel,
		});
	}

	// First-run setup

	private skippedKeys = new Set<string>();

	private nextSetupStep(): View | null {
		const status = this.settings.setupStatus();
		if (status.error) {
			this.status = { kind: "error", text: formatError(status.error) };
			return null;
		}
		const role = status.missingModels[0];
		if (role) {
			let view: SettingView;
			try {
				view = this.settings.getSetting(`models.${role}`);
			} catch (error) {
				this.setError(error);
				return null;
			}
			return this.modelView(view, () => this.advanceSetup(), () => this.close(false), false);
		}
		const provider = status.providersWithoutKey.find((p) => !this.skippedKeys.has(p));
		if (provider) {
			return this.keyEntryView(
				provider,
				() => this.advanceSetup(),
				() => {
					this.skippedKeys.add(provider);
					this.setInfo(`Skipped the ${provider} key (fine for keyless or local providers)`);
					this.advanceSetup();
				},
			);
		}
		return null;
	}

	private advanceSetup(): void {
		const next = this.nextSetupStep();
		if (next) this.show(next);
		else this.close(true);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		this.view.handleInput(data);
		this.requestRender();
	}

	render(width: number): string[] {
		const title = this.view.title;
		const lines: string[] = [""];
		lines.push(truncateToWidth(style.bold(style.cyan(this.mode === "setup" ? "nexo setup" : "Settings")), width));
		if (this.intro) lines.push(truncateToWidth(style.gray(this.intro), width));
		if (title !== "Settings") lines.push(truncateToWidth(style.bold(title), width));
		lines.push(...this.view.render(width));
		if (this.status) lines.push(truncateToWidth(this.status.kind === "error" ? style.red(this.status.text) : style.green(this.status.text), width));
		lines.push(truncateToWidth(style.gray(this.view.hint), width));
		return lines;
	}

	invalidate(): void {}
}
