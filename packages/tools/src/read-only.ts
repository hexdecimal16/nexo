/**
 * A conservative check that a bash command only reads, so auto mode can allow it without calling the approver.
 * False means "not proven read-only", never "unsafe": such commands still go to the approver.
 */

type Token = { type: "word"; value: string } | { type: "op"; value: string } | { type: "redirect"; value: string };

/** Splits a command into words, control operators and redirections; null when it uses anything this check does not model. */
function tokenize(command: string): Token[] | null {
	const tokens: Token[] = [];
	let word = "";
	let inWord = false;
	const flush = () => {
		if (inWord) tokens.push({ type: "word", value: word });
		word = "";
		inWord = false;
	};
	let i = 0;
	while (i < command.length) {
		const c = command[i] as string;
		const next = command[i + 1];
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end < 0) return null;
			word += command.slice(i + 1, end);
			inWord = true;
			i = end + 1;
			continue;
		}
		if (c === '"') {
			i++;
			for (;;) {
				const d = command[i];
				if (d === undefined) return null;
				if (d === '"') break;
				if (d === "`") return null;
				if (d === "$" && !(command[i + 1] === '"' || command[i + 1] === undefined || /\s/.test(command[i + 1] as string))) return null;
				if (d === "\\" && command[i + 1] !== undefined && '$`"\\'.includes(command[i + 1] as string)) {
					word += command[i + 1];
					i += 2;
					continue;
				}
				word += d;
				i++;
			}
			inWord = true;
			i++;
			continue;
		}
		if (c === "\\") {
			if (next === undefined || next === "\n") return null;
			word += next;
			inWord = true;
			i += 2;
			continue;
		}
		if (c === "`" || c === "(" || c === ")" || c === "\n" || c === "\r") return null;
		if (c === "$" && !(next === undefined || /\s/.test(next))) return null;
		if (c === " " || c === "\t") {
			flush();
			i++;
			continue;
		}
		if (c === "&" && next === "&") {
			flush();
			tokens.push({ type: "op", value: "&&" });
			i += 2;
			continue;
		}
		if (c === "|") {
			flush();
			tokens.push({ type: "op", value: next === "|" ? "||" : "|" });
			i += next === "|" ? 2 : 1;
			continue;
		}
		if (c === ";") {
			flush();
			tokens.push({ type: "op", value: ";" });
			i++;
			continue;
		}
		if (c === ">" || c === "<" || (c === "&" && next === ">")) {
			// A preceding all-digit word is the file descriptor (`2>`).
			let op = "";
			if (inWord && /^\d+$/.test(word)) {
				op = word;
				word = "";
				inWord = false;
			}
			flush();
			if (c === "&") {
				op += "&";
				i++;
			}
			op += command[i];
			i++;
			if (command[i] === ">") {
				op += ">";
				i++;
			}
			if (command[i] === "&") {
				// `2>&1`: a descriptor duplication, no file.
				const m = /^&\d+/.exec(command.slice(i));
				if (!m) return null;
				tokens.push({ type: "redirect", value: `${op}${m[0]}` });
				i += m[0].length;
				continue;
			}
			while (command[i] === " " || command[i] === "\t") i++;
			const m = /^[^\s;&|<>()`$'"\\]+/.exec(command.slice(i));
			if (!m) return null;
			tokens.push({ type: "redirect", value: `${op}${m[0]}` });
			i += m[0].length;
			continue;
		}
		if (c === "&") return null; // background job
		word += c;
		inWord = true;
		i++;
	}
	flush();
	return tokens;
}

/** Only discarding output or merging stderr into stdout; never writing or reading a file. */
const SAFE_REDIRECT = /^(\d*>{1,2}\/dev\/null|&>{1,2}\/dev\/null|\d*>&\d)$/;

/** Arguments that point at secrets: reading them would send them to the model, so the approver decides. */
const SENSITIVE =
	/(^|[/~])\.(ssh|aws|gnupg|kube|docker|netrc|npmrc|pypirc|git-credentials|env|nexo)(\b|$)|id_(rsa|dsa|ecdsa|ed25519)|credential|secret|token|passw|\.pem$|\.key$|\.p12$|keychain/i;

/** Programs that only read or print whatever their arguments, unless one of their listed flags is present. */
const SIMPLE: Record<string, readonly string[]> = {
	cat: [],
	head: [],
	tail: [],
	wc: [],
	ls: [],
	pwd: [],
	echo: [],
	printf: [],
	which: [],
	type: [],
	stat: [],
	du: [],
	df: [],
	diff: [],
	cmp: [],
	comm: [],
	whoami: [],
	id: [],
	uname: [],
	jq: [],
	true: [],
	false: [],
	basename: [],
	dirname: [],
	realpath: [],
	readlink: [],
	cut: [],
	tr: [],
	nl: [],
	rev: [],
	column: [],
	grep: [],
	egrep: [],
	fgrep: [],
	test: [],
	"[": [],
	strings: [],
	od: [],
	md5: [],
	md5sum: [],
	shasum: [],
	sha1sum: [],
	sha256sum: [],
	ps: [],
	uptime: [],
	cd: [],
	file: ["-C"],
	tree: ["-o"],
	date: ["-s", "--set"],
	rg: ["--pre"],
};

function hasFlag(args: readonly string[], flags: readonly string[]): boolean {
	return args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`) || (f.length === 2 && a.startsWith(f))));
}

const SED_ADDRESS = String.raw`(\d+|\$|/([^/\\]|\\.)*/)`;
const SED_COMMAND = String.raw`(${SED_ADDRESS}(,${SED_ADDRESS})?)?\s*([pdq=]|s/([^/\\]|\\.)*/([^/\\]|\\.)*/[gpiI0-9]*)`;
/** Printing, deleting from the output and substitutions without the `w` or `e` flags; no `w`, `r` or `e` commands. */
const SAFE_SED_SCRIPT = new RegExp(`^\\s*${SED_COMMAND}(\\s*;\\s*${SED_COMMAND})*\\s*;?\\s*$`);

function sedReadOnly(args: readonly string[]): boolean {
	const scripts: string[] = [];
	const operands: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i] as string;
		if (a === "-e" || a === "--expression") {
			const s = args[++i];
			if (s === undefined) return false;
			scripts.push(s);
		} else if (a === "-n" || a === "-E" || a === "-r" || a === "--quiet" || a === "--silent") {
			// harmless
		} else if (a.startsWith("-")) {
			return false; // -i (in place), -f (script file) and anything else
		} else operands.push(a);
	}
	if (scripts.length === 0) {
		const s = operands.shift();
		if (s === undefined) return false;
		scripts.push(s);
	}
	return scripts.every((s) => SAFE_SED_SCRIPT.test(s));
}

const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** Git subcommands that only read; `branch`, `tag`, `remote`, `stash` and `reflog` only in their listing forms. */
const GIT_READ = new Set(["status", "log", "show", "diff", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "describe", "shortlog", "cat-file", "rev-list", "merge-base", "show-ref"]);
const GIT_BRANCH_LIST_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--all", "--remotes", "--verbose", "--show-current", "--list", "-l"]);

function gitReadOnly(args: readonly string[]): boolean {
	let i = 0;
	// Global options before the subcommand: only `-C <dir>` and `--no-pager` (never `-c`, which can set an alias or pager).
	while (i < args.length && (args[i] as string).startsWith("-")) {
		if (args[i] === "-C") i += 2;
		else if (args[i] === "--no-pager") i++;
		else return false;
	}
	const sub = args[i];
	const rest = args.slice(i + 1);
	if (sub === undefined) return false;
	// `--output` writes a file and `-O` / `--open-files-in-pager` runs a program.
	if (rest.some((a) => a.startsWith("--output") || a.startsWith("-O") || a.startsWith("--open-files-in-pager"))) return false;
	if (GIT_READ.has(sub)) return true;
	const positionals = rest.filter((a) => !a.startsWith("-"));
	switch (sub) {
		case "branch":
			return rest.every((a) => !a.startsWith("-") || GIT_BRANCH_LIST_FLAGS.has(a)) && (positionals.length === 0 || rest.includes("--list") || rest.includes("-l"));
		case "tag":
			return rest.every((a) => !a.startsWith("-") || a === "-l" || a === "--list" || a === "-n") && (positionals.length === 0 || rest.includes("--list") || rest.includes("-l"));
		case "remote":
			return rest.length === 0 || (rest.length === 1 && rest[0] === "-v") || rest[0] === "show" || rest[0] === "get-url";
		case "stash":
			return rest[0] === "list" || rest[0] === "show";
		case "reflog":
			return rest.length === 0 || rest[0] === "show";
		default:
			return false;
	}
}

/** `gh <object> <verb>` pairs that only read from GitHub. `gh api` and `gh auth` are never read-only here. */
const GH_READ: Record<string, readonly string[]> = {
	pr: ["view", "diff", "list", "checks", "status"],
	issue: ["view", "list", "status"],
	repo: ["view"],
	run: ["view", "list"],
	release: ["view", "list"],
	workflow: ["view", "list"],
};

function ghReadOnly(args: readonly string[]): boolean {
	const [object, verb] = args;
	if (object === undefined || verb === undefined) return false;
	if (args.some((a) => a === "--web" || a === "-w")) return false;
	if (object === "search") return true;
	return GH_READ[object]?.includes(verb) ?? false;
}

function uniqReadOnly(args: readonly string[]): boolean {
	// A second operand is an output file.
	return args.filter((a) => !a.startsWith("-")).length <= 1;
}

function sortReadOnly(args: readonly string[]): boolean {
	return !args.some((a) => a.startsWith("--output") || /^-[a-zA-Z]*o/.test(a) || a === "--compress-program" || a.startsWith("--compress-program="));
}

function findReadOnly(args: readonly string[]): boolean {
	return !args.some((a) => FIND_WRITES.has(a));
}

/** Dot-commands that only print; any other (`.shell`, `.output`, `.import`, `.read`) can run programs or write files. */
const SQLITE_SAFE_DOT = /^\.(schema|tables|indexes|indices|databases|headers|mode|timer)\b/;
/** SQL the sqlite3 shell runs even on a read-only connection: file writes, extensions, other databases. */
const SQLITE_UNSAFE_SQL = /\b(writefile|readfile|edit|load_extension|fsdir|attach)\b/i;
const SQLITE_SAFE_FLAGS = new Set(["-readonly", "-header", "-noheader", "-column", "-line", "-list", "-csv", "-json", "-markdown", "-table", "-batch"]);

/** `sqlite3 -readonly <db> [sql|.schema ...]`: the connection cannot write, and no argument reaches the shell or a file. */
function sqliteReadOnly(args: readonly string[]): boolean {
	if (!args.includes("-readonly")) return false;
	return args.every((a) => {
		if (a.startsWith("-")) return SQLITE_SAFE_FLAGS.has(a);
		if (a.startsWith(".")) return SQLITE_SAFE_DOT.test(a);
		return !SQLITE_UNSAFE_SQL.test(a);
	});
}

const PROGRAMS: Record<string, (args: readonly string[]) => boolean> = {
	sqlite3: sqliteReadOnly,
	sed: sedReadOnly,
	git: gitReadOnly,
	gh: ghReadOnly,
	uniq: uniqReadOnly,
	sort: sortReadOnly,
	find: findReadOnly,
};

function simpleCommandReadOnly(words: readonly string[]): boolean {
	const [program, ...args] = words;
	// A path (`./cat`) could be any program; an assignment (`GIT_PAGER=x git log`) changes what runs.
	if (program === undefined || program.includes("/") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) return false;
	const check = PROGRAMS[program];
	if (check) return check(args);
	const denied = SIMPLE[program];
	return denied !== undefined && !hasFlag(args, denied);
}

/**
 * True when every command in `command` (joined by `&&`, `||`, `;` or `|`) is a known read-only program used in a
 * read-only way, its only redirections discard output, and no argument names a credential file. Anything with command
 * substitution, variable expansion, subshells, background jobs or unknown programs is false.
 */
export function isReadOnlyCommand(command: string): boolean {
	const tokens = tokenize(command);
	if (!tokens || tokens.length === 0) return false;
	const segments: string[][] = [[]];
	for (const token of tokens) {
		if (token.type === "op") segments.push([]);
		else if (token.type === "redirect") {
			if (!SAFE_REDIRECT.test(token.value)) return false;
		} else {
			if (SENSITIVE.test(token.value)) return false;
			(segments[segments.length - 1] as string[]).push(token.value);
		}
	}
	return segments.every((words) => words.length > 0 && simpleCommandReadOnly(words));
}
