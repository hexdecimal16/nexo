import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const sgr = (open: string, close: string) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;

export const style = {
	bold: sgr("1", "22"),
	dim: sgr("2", "22"),
	italic: sgr("3", "23"),
	underline: sgr("4", "24"),
	strike: sgr("9", "29"),
	red: sgr("31", "39"),
	green: sgr("32", "39"),
	yellow: sgr("33", "39"),
	blue: sgr("34", "39"),
	magenta: sgr("35", "39"),
	cyan: sgr("36", "39"),
	gray: sgr("90", "39"),
};

export const markdownTheme: MarkdownTheme = {
	heading: (t) => style.bold(style.cyan(t)),
	link: style.underline,
	linkUrl: style.gray,
	code: style.yellow,
	codeBlock: (t) => t,
	codeBlockBorder: style.gray,
	quote: style.italic,
	quoteBorder: style.gray,
	hr: style.gray,
	listBullet: style.cyan,
	bold: style.bold,
	italic: style.italic,
	strikethrough: style.strike,
	underline: style.underline,
};

export const selectListTheme: SelectListTheme = {
	selectedPrefix: style.cyan,
	selectedText: (t) => style.bold(style.cyan(t)),
	description: style.gray,
	scrollInfo: style.gray,
	noMatch: style.gray,
};

/** Editor border and footer color while the input is a `!` shell command. */
export const shellBorder = style.magenta;

export const editorTheme: EditorTheme = {
	borderColor: style.dim,
	selectList: selectListTheme,
};
