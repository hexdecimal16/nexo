const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
/** Longest key kept while scanning; anything longer cannot be `text`. */
const KEY_CHARS = 16;

/**
 * Reads a `{ "text": string, "tool_calls": [...] }` reply as it streams and returns the decoded characters of the
 * top-level `text` value as they arrive, so a tools turn can show what the model is saying before the reply is whole.
 * Text before the object (prose, a code fence) is skipped, as is an object that closes without a `text` string. Only
 * the first `text` value is read: a reply the model writes twice streams once.
 */
export class ReplyTextExtractor {
	private mode: "seek" | "object" | "string" | "text" | "done" = "seek";
	private depth = 0;
	/** Inside `string`: the previous character was a backslash. */
	private escaped = false;
	/** The depth-1 string being read, and the last one that closed (a key when a colon follows). */
	private current = "";
	private lastString: string | null = null;
	/** A `"text":` key was just read; the next value is the one to stream if it is a string. */
	private wantText = false;
	/** Inside `text`: a partial escape sequence carried over from the previous chunk (`\` or `\u12`). */
	private escape = "";

	/** True once the `text` value has closed. */
	get done(): boolean {
		return this.mode === "done";
	}

	/** Feeds the next piece of the reply and returns the characters of `text` it completed (often empty). */
	push(chunk: string): string {
		let out = "";
		for (const ch of chunk) {
			switch (this.mode) {
				case "done":
					return out;
				case "seek":
					if (ch === "{") {
						this.mode = "object";
						this.depth = 1;
						this.lastString = null;
						this.wantText = false;
					}
					break;
				case "object":
					if (ch === '"') {
						if (this.wantText && this.depth === 1) {
							this.mode = "text";
							this.escape = "";
						} else {
							this.mode = "string";
							this.escaped = false;
							this.current = "";
						}
					} else if (ch === "{" || ch === "[") {
						this.depth++;
						this.wantText = false;
					} else if (ch === "}" || ch === "]") {
						this.depth--;
						if (this.depth === 0) this.mode = "seek";
					} else if (ch === ":") {
						if (this.depth === 1 && this.lastString === "text") this.wantText = true;
						this.lastString = null;
					} else if (!/\s/.test(ch)) {
						// A number, literal or comma: whatever follows is not the `text` string.
						this.wantText = false;
						this.lastString = null;
					}
					break;
				case "string":
					if (this.escaped) this.escaped = false;
					else if (ch === "\\") this.escaped = true;
					else if (ch === '"') {
						this.mode = "object";
						this.lastString = this.depth === 1 ? this.current : null;
						break;
					}
					if (this.depth === 1 && this.current.length <= KEY_CHARS) this.current += ch;
					break;
				case "text":
					if (this.escape) {
						this.escape += ch;
						if (this.escape[1] === "u") {
							if (this.escape.length < 6) break;
							const code = Number.parseInt(this.escape.slice(2), 16);
							out += Number.isNaN(code) ? "" : String.fromCharCode(code);
						} else out += SIMPLE_ESCAPES[ch] ?? ch;
						this.escape = "";
					} else if (ch === "\\") this.escape = ch;
					else if (ch === '"') this.mode = "done";
					else out += ch;
					break;
			}
		}
		return out;
	}
}
