import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutocompleteProvider, findFd, scoreEntry, walkFiles, withDirectories } from "../src/file-autocomplete.ts";

let dir: string;

function touch(rel: string): void {
	const full = join(dir, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, "x");
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "nexo-at-"));
	touch("README.md");
	touch("src/app.ts");
	touch("src/deep/app-helper.ts");
	touch("node_modules/pkg/app.ts");
	touch("notes/my notes.md");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ask = (provider: ReturnType<typeof createAutocompleteProvider>, line: string) =>
	provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });

describe("@file autocomplete without fd", () => {
	it("suggests project files, skipping node_modules", async () => {
		const result = await ask(createAutocompleteProvider([], dir, null), "look at @app");
		const values = result?.items.map((i) => i.value) ?? [];
		expect(result?.prefix).toBe("@app");
		expect(values[0]).toBe("@src/app.ts");
		expect(values).toContain("@src/deep/app-helper.ts");
		expect(values.some((v) => v.includes("node_modules"))).toBe(false);
	});

	it("lists top entries for a bare @ and suggests directories with a trailing slash", async () => {
		const bare = await ask(createAutocompleteProvider([], dir, null), "@");
		expect(bare?.items.length).toBeGreaterThan(0);
		const dirs = await ask(createAutocompleteProvider([], dir, null), "@sr");
		expect(dirs?.items[0]).toMatchObject({ value: "@src/", label: "src/" });
	});

	it("quotes paths that contain spaces", async () => {
		const result = await ask(createAutocompleteProvider([], dir, null), "@notes");
		expect(result?.items.map((i) => i.value)).toContain('@"notes/my notes.md"');
	});

	it("returns null when nothing matches and ignores an @ inside a word", async () => {
		expect(await ask(createAutocompleteProvider([], dir, null), "@zzzqqq")).toBeNull();
		expect(await ask(createAutocompleteProvider([], dir, null), "mail me@app")).toBeNull();
	});

	it("inserts the chosen path in place of the @ prefix", async () => {
		const provider = createAutocompleteProvider([], dir, null);
		const result = await ask(provider, "see @READ");
		const item = result?.items[0];
		expect(item?.value).toBe("@README.md");
		const applied = provider.applyCompletion(["see @READ"], 0, 9, item as NonNullable<typeof item>, result?.prefix ?? "");
		expect(applied.lines[0]).toBe("see @README.md ");
	});

	it("still completes slash commands", async () => {
		const result = await ask(createAutocompleteProvider([{ name: "help", description: "List" }], dir, null), "/he");
		expect(result?.items.map((i) => i.value)).toEqual(["help"]);
	});
});

describe("@file autocomplete inside a git repo", () => {
	it("uses git ls-files, so ignored files are not suggested but untracked ones are", async () => {
		execFileSync("git", ["init", "-q"], { cwd: dir });
		writeFileSync(join(dir, ".gitignore"), "ignored-app.ts\n");
		touch("ignored-app.ts");
		touch("fresh-app.ts");
		const result = await ask(createAutocompleteProvider([], dir, null), "@app");
		const values = result?.items.map((i) => i.value) ?? [];
		expect(values).toContain("@fresh-app.ts");
		expect(values).toContain("@src/app.ts");
		expect(values).not.toContain("@ignored-app.ts");
	});
});

describe("helpers", () => {
	it("walkFiles skips dependency directories and uses forward slashes", () => {
		const files = walkFiles(dir).sort();
		expect(files).toEqual(["README.md", "notes/my notes.md", "src/app.ts", "src/deep/app-helper.ts"]);
	});

	it("withDirectories adds every parent directory once", () => {
		const dirs = withDirectories(["a/b/c.ts", "a/d.ts"]).filter((e) => e.isDirectory).map((e) => e.path);
		expect(dirs.sort()).toEqual(["a/", "a/b/"]);
	});

	it("scoreEntry ranks basename prefix over substring over path match", () => {
		expect(scoreEntry("src/app.ts", false, "app")).toBeGreaterThan(scoreEntry("src/my-app.ts", false, "app"));
		expect(scoreEntry("src/my-app.ts", false, "app")).toBeGreaterThan(scoreEntry("app/index.ts", false, "src"));
		expect(scoreEntry("src/x.ts", false, "zzz")).toBe(0);
	});

	it("findFd finds fd, fdfind or fd.exe on PATH per platform", () => {
		touch("bin/fdfind");
		touch("bin/fd.exe");
		const env = { PATH: join(dir, "bin") };
		expect(findFd(env, "linux")).toBe(join(dir, "bin", "fdfind"));
		expect(findFd(env, "win32")).toBe(join(dir, "bin", "fd.exe"));
		expect(findFd({ PATH: join(dir, "nope") }, "linux")).toBeNull();
	});
});
