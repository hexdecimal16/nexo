import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { NexoError } from "@nexo/telemetry";
import { createModelRegistry } from "../src/index.ts";

describe("createModelRegistry", () => {
	const faux = fauxProvider({ models: [{ id: "fast" }, { id: "thinker", reasoning: true }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createModelRegistry(models);

	it("returns known models", () => {
		expect(registry.get("faux", "fast").id).toBe("fast");
	});

	it("throws CONFIG_INVALID for unknown models", () => {
		try {
			registry.get("faux", "nope");
			expect.unreachable();
		} catch (err) {
			expect((err as NexoError).code).toBe("CONFIG_INVALID");
			expect((err as NexoError).message).toContain("faux/nope");
		}
	});

	it("clamps effort to what the model supports", () => {
		expect(registry.clampEffort(registry.get("faux", "fast"), "high")).toBe("off");
		expect(registry.clampEffort(registry.get("faux", "thinker"), "high")).toBe("high");
	});
});
