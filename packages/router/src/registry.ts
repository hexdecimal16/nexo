import { type Api, clampThinkingLevel, type Model, type Models } from "@earendil-works/pi-ai";
import { NexoError } from "@nexo/telemetry";
import type { Effort } from "./effort.ts";

export interface ModelRegistry {
	get(provider: string, id: string): Model<Api>;
	clampEffort(model: Model<Api>, effort: Effort): Effort;
}

export function createModelRegistry(models: Models): ModelRegistry {
	return {
		get(provider, id) {
			const model = models.getModel(provider, id);
			if (!model) {
				throw new NexoError({
					code: "CONFIG_INVALID",
					message: `Unknown model "${provider}/${id}"`,
					hint: "Use a provider/model id from pi-ai's catalog; check models.* in config and nexo-model in skills",
					context: { provider, id },
				});
			}
			return model;
		},
		clampEffort(model, effort) {
			return clampThinkingLevel(model, effort) as Effort;
		},
	};
}
