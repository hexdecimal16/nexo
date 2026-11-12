import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyRegistry, readRegistry, writeRegistry } from "@nexo/core";
import { areasCommand } from "../src/areas.ts";

function setup() {
	const home = mkdtempSync(join(tmpdir(), "nexo-areas-cli-"));
	const wikis = join(home, "home");
	mkdirSync(wikis, { recursive: true });
	const area = (id: string, status: "active" | "proposed") => ({ id, name: id, scope: `${id} scope`, examples: [], aliases: [], wikis: [], status, createdAt: "2026-11-11" });
	writeRegistry(wikis, { ...emptyRegistry(), areas: [area("work", "active"), area("travel", "proposed"), area("media", "proposed")] });
	let out = "";
	const io = { stdout: { write: (t: string) => ((out += t), true) }, stderr: { write: () => true } };
	return { wikis, io, env: { NEXO_HOME: home }, out: () => out };
}

describe("nexo areas", () => {
	it("lists active and proposed areas", () => {
		const s = setup();
		expect(areasCommand([], s.io, { env: s.env })).toBe(0);
		expect(s.out()).toContain("Active:");
		expect(s.out()).toContain("travel");
	});

	it("approves and rejects only proposed areas", () => {
		const s = setup();
		areasCommand(["approve", "travel"], s.io, { env: s.env });
		areasCommand(["reject", "media"], s.io, { env: s.env });
		expect(readRegistry(s.wikis).areas.map((a) => `${a.id}:${a.status}`)).toEqual(["work:active", "travel:active"]);
		expect(() => areasCommand(["reject", "work"], s.io, { env: s.env })).toThrow();
		expect(() => areasCommand(["approve"], s.io, { env: s.env })).toThrow();
	});
});
