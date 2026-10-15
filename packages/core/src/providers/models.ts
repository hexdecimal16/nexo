import type { MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { claudePProvider } from "./claude-p.ts";

/** pi-ai's built-in providers plus nexo's own (`claude-p`). */
export function nexoModels(): MutableModels {
	const models = builtinModels();
	models.setProvider(claudePProvider());
	return models;
}
