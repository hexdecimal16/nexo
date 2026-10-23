import { approverModel, createSettings, nexoModels } from "@nexo/core";
import { createModelRegistry } from "@nexo/router";
import type { NexoPaths } from "@nexo/store";
import type { CompanionModel } from "@nexo/web";

type Models = Parameters<typeof createSettings>[0]["models"];

/** nex's model for `nexo ui`: the s1 role (the small, cheap model), with the same keys and settings as `nexo run`. Null when it cannot be set up. */
export function companionModel(options: { env: NodeJS.ProcessEnv; cwd: string; models?: Models }, paths: NexoPaths): CompanionModel | null {
	try {
		const models = options.models ?? nexoModels();
		const settings = createSettings({ paths, cwd: options.cwd, env: options.env, models });
		// The approver (auto-classifier) tier: small and fast, and it falls back to s1 when models.approver is unset.
		const small = approverModel(settings.loadConfig().config);
		const model = createModelRegistry(models).get(small.provider, small.id);
		return {
			async complete({ system, user, signal }) {
				const msg = await models.completeSimple(model, { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] }, { apiKey: settings.resolveApiKey(model.provider), maxTokens: 700, signal });
				if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage ?? "The companion model failed");
				return msg.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			},
		};
	} catch {
		return null;
	}
}
