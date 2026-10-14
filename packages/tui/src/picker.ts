import { type Component, fuzzyFilter, matchesKey, type SelectItem, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import { fitLines } from "./components.ts";
import { escapeControl } from "./text.ts";
import { selectListTheme, style } from "./theme.ts";

export interface View extends Component {
	readonly title: string;
	readonly hint: string;
	handleInput(data: string): void;
}

/** A list filtered by typing. With `freeText`, Enter on a filter that matches nothing picks the filter text. */
export class PickerView implements View {
	readonly title: string;
	readonly hint: string;
	private readonly items: SelectItem[];
	private readonly freeText: boolean;
	private readonly maxVisible: () => number;
	private readonly onPick: (value: string) => void;
	private readonly onCancel: () => void;
	private readonly labelWidth: { min: number; max: number };
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
		/** Width bounds of the label column (default 20–32). */
		labelWidth?: { min: number; max: number };
	}) {
		this.title = options.title;
		this.items = options.items;
		this.freeText = options.freeText ?? false;
		this.maxVisible = options.maxVisible;
		this.onPick = options.onPick;
		this.onCancel = options.onCancel;
		this.hint = options.hint ?? "type to filter · ↑↓ move · enter select · esc back";
		this.labelWidth = options.labelWidth ?? { min: 20, max: 32 };
		this.filtered = this.items;
		this.list = this.buildList();
	}

	private buildList(): SelectList {
		const items = this.filtered.length > 0 ? this.filtered : [];
		const list = new SelectList(items, Math.max(3, this.maxVisible()), selectListTheme, { minPrimaryColumnWidth: this.labelWidth.min, maxPrimaryColumnWidth: this.labelWidth.max });
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
		return fitLines(lines, width);
	}

	invalidate(): void {}
}
