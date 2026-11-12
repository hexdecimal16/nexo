import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { homeCommand } from "../src/home-migrate.ts";

function setup() {
	const home = mkdtempSync(join(tmpdir(), "nexo-home-mig-"));
	const w = join(home, "wikis");
	mkdirSync(join(w, "nexo"), { recursive: true });
	mkdirSync(join(w, "ai", "concepts"), { recursive: true });
	mkdirSync(join(w, "stray"));
	writeFileSync(join(w, "nexo", "overview.html"), "<html></html>");
	writeFileSync(join(w, "ai", "concepts", "x.html"), '<a href="../../nexo/overview.html#top">n</a><a href="y.html">y</a><a href="https://e.com/a.html">e</a>');
	const area = (id: string, wikis: string[]) => ({ id, name: id, scope: "", examples: [], aliases: [], wikis, status: "active", createdAt: "2026-11-12" });
	writeFileSync(join(w, "areas.json"), JSON.stringify({ version: 1, areas: [area("builds", ["nexo"]), area("research", ["ai"])], unsorted: [] }));
	writeFileSync(join(w, "feed.jsonl"), "{}\n");
	let out = "";
	const io = { stdout: { write: (t: string) => ((out += t), true) }, stderr: { write: () => true } };
	return { home, w, io, env: { NEXO_HOME: home }, out: () => out };
}

describe("nexo home migrate", () => {
	it("dry run lists the moves and changes nothing", () => {
		const s = setup();
		expect(homeCommand(["migrate"], s.io, { env: s.env })).toBe(0);
		expect(s.out()).toContain("home/builds/nexo");
		expect(s.out()).toContain("home/unsorted/stray");
		expect(existsSync(join(s.w, "nexo"))).toBe(true);
		expect(existsSync(join(s.home, "home"))).toBe(false);
	});

	it("applies the move, rewrites cross-folder links, and undoes both", () => {
		const s = setup();
		homeCommand(["migrate", "--apply"], s.io, { env: s.env });
		const h = join(s.home, "home");
		expect(existsSync(join(h, "builds", "nexo", "overview.html"))).toBe(true);
		expect(existsSync(join(h, "unsorted", "stray"))).toBe(true);
		expect(existsSync(join(h, "areas.json"))).toBe(true);
		expect(existsSync(join(s.w, "nexo"))).toBe(false);
		const page = readFileSync(join(h, "research", "ai", "concepts", "x.html"), "utf8");
		expect(page).toContain('href="../../../builds/nexo/overview.html#top"');
		expect(page).toContain('href="y.html"');
		expect(page).toContain('href="https://e.com/a.html"');
		homeCommand(["migrate", "--undo"], s.io, { env: s.env });
		expect(readFileSync(join(s.w, "ai", "concepts", "x.html"), "utf8")).toContain('href="../../nexo/overview.html#top"');
		expect(existsSync(join(s.w, "areas.json"))).toBe(true);
		expect(existsSync(join(h, "builds", "nexo"))).toBe(false);
	});
});
