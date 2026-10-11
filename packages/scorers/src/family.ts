export interface ModelRef {
	provider: string;
	id: string;
}

/** Model-id prefixes of the main model families. Aggregators (openrouter, bedrock, vertex) serve these under other providers. */
const FAMILY_PREFIXES: readonly [RegExp, string][] = [
	[/(^|[/.:])(claude|anthropic)/i, "anthropic"],
	[/(^|[/.:])(gpt|o[1-9](-|$)|chatgpt|openai|codex)/i, "openai"],
	[/(^|[/.:])(gemini|gemma|google)/i, "google"],
	[/(^|[/.:])(llama|meta-llama)/i, "meta"],
	[/(^|[/.:])(mistral|mixtral|codestral|magistral|devstral|ministral|pixtral)/i, "mistral"],
	[/(^|[/.:])grok/i, "xai"],
	[/(^|[/.:])deepseek/i, "deepseek"],
	[/(^|[/.:])(qwen|qwq)/i, "qwen"],
	[/(^|[/.:])(kimi|moonshot)/i, "moonshot"],
	[/(^|[/.:])(glm|zai)/i, "zhipu"],
	[/(^|[/.:])(command|cohere)/i, "cohere"],
];

/** Providers that serve one family under its own name. */
const PROVIDER_FAMILIES: Record<string, string> = {
	anthropic: "anthropic",
	openai: "openai",
	google: "google",
	"google-vertex": "google",
	mistral: "mistral",
	xai: "xai",
	deepseek: "deepseek",
};

/** The model family of a provider/model pair: from the model id when it names a known family, else from the provider. */
export function modelFamily(model: ModelRef): string {
	for (const [re, family] of FAMILY_PREFIXES) if (re.test(model.id)) return family;
	if (model.provider.startsWith("azure")) return "openai";
	return PROVIDER_FAMILIES[model.provider] ?? model.provider;
}

export function modelKeyOf(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}

/** Every (judge, generator) pair whose models come from the same family, in judge order, then generator order. */
export function sameFamilyPairs(judges: readonly ModelRef[], generators: readonly ModelRef[]): { judge: string; generator: string; family: string }[] {
	const out: { judge: string; generator: string; family: string }[] = [];
	for (const judge of judges) {
		const family = modelFamily(judge);
		for (const generator of generators) {
			if (modelFamily(generator) === family) out.push({ judge: modelKeyOf(judge), generator: modelKeyOf(generator), family });
		}
	}
	return out;
}
