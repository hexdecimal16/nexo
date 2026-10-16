import type { MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { claudePProvider } from "./claude-p.ts";
import { kiroPProvider } from "./kiro-p.ts";

/** pi-ai's built-in providers plus nexo's own (`claude-p`, `kiro-p`). */
export function nexoModels(): MutableModels {
	const models = builtinModels();
	models.setProvider(claudePProvider());
	models.setProvider(kiroPProvider());
	return models;
}
