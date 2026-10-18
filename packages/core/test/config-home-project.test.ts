import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NexoError } from "@nexo/telemetry";
import { resolveNexoPaths } from "@nexo/store";
import { loadConfig } from "../src/index.ts";

const models = {
	s1: { provider: "faux", id: "fast" },
	s2: { provider: "faux", id: "slow" },
	embedding: { provider: "openai", id: "text-embedding-3-small" },
};

describe("loadConfig when the working directory is the nexo home parent", () => {
	it("treats ./.nexo/config.json as the user config when it is the same file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "nexo-home-cwd-"));
		const paths = resolveNexoPaths({ NEXO_HOME: join(cwd, ".nexo") });
		mkdirSync(paths.home, { recursive: true });
		writeFileSync(paths.config, JSON.stringify({ models }));

		const { config, sources } = loadConfig({ paths, cwd });
		expect(config.models.embedding?.id).toBe("text-embedding-3-small");
		expect(sources).toEqual([paths.config]);
	});

	it("still rejects models.embedding in a different project config", () => {
		const root = mkdtempSync(join(tmpdir(), "nexo-home-proj-"));
		const paths = resolveNexoPaths({ NEXO_HOME: join(root, "home") });
		const cwd = join(root, "proj");
		mkdirSync(paths.home, { recursive: true });
		mkdirSync(join(cwd, ".nexo"), { recursive: true });
		writeFileSync(paths.config, JSON.stringify({ models: { s1: models.s1, s2: models.s2 } }));
		writeFileSync(join(cwd, ".nexo", "config.json"), JSON.stringify({ models: { embedding: models.embedding } }));

		try {
			loadConfig({ paths, cwd });
		} catch (err) {
			expect((err as NexoError).code).toBe("CONFIG_INVALID");
			expect((err as NexoError).message).toContain("/models/embedding must not be set in ./.nexo/config.json");
			return;
		}
		throw new Error("expected CONFIG_INVALID");
	});
});
