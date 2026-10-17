import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSetting } from "../src/settings/config-edit.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "nexo-embed-"));
	dirs.push(d);
	return d;
};

describe("models.embedding setting", () => {
	it("writes provider and id and keeps the other embedding keys", () => {
		const dir = tmp();
		const file = join(dir, "config.json");
		writeFileSync(file, JSON.stringify({ models: { embedding: { provider: "openai", id: "old", dimensions: 256 } } }));
		const view = writeSetting(file, dir, "models.embedding", "openai/text-embedding-3-small");
		expect(view).toMatchObject({ key: "models.embedding", value: "openai/text-embedding-3-small", source: "user" });
		expect(JSON.parse(readFileSync(file, "utf8")).models.embedding).toEqual({ provider: "openai", id: "text-embedding-3-small", dimensions: 256 });
	});

	it("rejects a value that is not provider/model-id", () => {
		const dir = tmp();
		expect(() => writeSetting(join(dir, "config.json"), dir, "models.embedding", "nonsense")).toThrow(/provider\/model-id/);
	});
});
