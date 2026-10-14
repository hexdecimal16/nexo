import { ScorerSpecSchema } from "@nexo/scorers";
import { type Static, Type } from "typebox";

/** Written out literally so the static type is the union of effort names; a test checks it accepts exactly `EFFORTS`. */
export const EffortSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

const ModelSpecSchema = Type.Object(
	{ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), effort: Type.Optional(EffortSchema) },
	{ additionalProperties: false },
);
/**
 * An OpenAI-compatible embeddings endpoint (`POST {baseUrl}/embeddings`); `baseUrl` defaults to OpenAI's for provider
 * `openai`. Provider `google-vertex` uses the Vertex AI API instead and takes no `baseUrl`.
 */
const EmbeddingModelSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		id: Type.String({ minLength: 1 }),
		baseUrl: Type.Optional(Type.String({ pattern: "^https?://[^\\s]+$" })),
		dimensions: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })),
	},
	{ additionalProperties: false },
);
const ModelRefSchema = Type.Object({ ref: Type.Union([Type.Literal("s1"), Type.Literal("s2")]) }, { additionalProperties: false });
const PolicyActionSchema = Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")]);
const ToolRuleSchema = Type.Object(
	{ tool: Type.String({ minLength: 1 }), match: Type.Optional(Type.String()), action: PolicyActionSchema },
	{ additionalProperties: false },
);
const NonInteractiveAskSchema = Type.Union([Type.Literal("allow"), Type.Literal("deny")]);
const LooseSection = Type.Object({}, { additionalProperties: true });
const Usd = Type.Number({ exclusiveMinimum: 0 });
/** `artifact:<kind>` (the active artifact of that kind, seeded with the built-in default) or `file:<path>`. */
const ArtifactSource = (kind: string) => Type.String({ pattern: `^(artifact:${kind}|file:.+)$` });

export const ConfigSchema = Type.Object(
	{
		models: Type.Object(
			{
				s1: ModelSpecSchema,
				s2: ModelSpecSchema,
				judge: Type.Optional(Type.Array(ModelSpecSchema)),
				reflector: Type.Optional(Type.Union([ModelSpecSchema, ModelRefSchema])),
				embedding: Type.Optional(EmbeddingModelSchema),
			},
			{ additionalProperties: false },
		),
		providers: Type.Record(
			Type.String(),
			Type.Object(
				{
					maxConcurrent: Type.Optional(Type.Integer({ minimum: 1 })),
					maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
					retryBaseDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
					rateLimitBaseDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
				},
				{ additionalProperties: false },
			),
		),
		router: Type.Object(
			{ policy: ArtifactSource("router_policy"), maxEscalations: Type.Integer({ minimum: 0 }) },
			{ additionalProperties: false },
		),
		scoring: Type.Object(
			{
				enabled: Type.Boolean(),
				scorers: Type.Array(ScorerSpecSchema),
				rubric: ArtifactSource("judge_rubric"),
				passThreshold: Type.Number({ minimum: 0, maximum: 1 }),
				commandTimeoutMs: Type.Integer({ minimum: 100 }),
				subagents: Type.Boolean(),
				/** Set by loadConfig: "project" when ./.nexo/config.json supplied `scorers`. A value in a config file is ignored. */
				scorersOrigin: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project")])),
				/**
				 * Set by loadConfig: the tool policy from the user-level layers only (defaults, ~/.nexo/config.json, CLI
				 * overrides). Project-level command scorers are checked against it, so ./.nexo/config.json cannot approve its
				 * own commands. A value in a config file is ignored.
				 */
				scorerTools: Type.Optional(
					Type.Object(
						{ policy: Type.Record(Type.String(), PolicyActionSchema), rules: Type.Array(ToolRuleSchema), nonInteractiveAsk: NonInteractiveAskSchema },
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
		budgets: Type.Object(
			{
				perRunUsd: Usd,
				perSessionUsd: Usd,
				dailyUsd: Usd,
				monthlyUsd: Usd,
				optimDefaultUsd: Usd,
				escalationCutoff: Type.Number({ minimum: 0, maximum: 1 }),
				estimateOutputTokens: Type.Integer({ minimum: 1 }),
			},
			{ additionalProperties: false },
		),
		session: Type.Object(
			{ compactAt: Type.Number({ exclusiveMinimum: 0, maximum: 1 }) },
			{ additionalProperties: false },
		),
		spawn: Type.Object(
			{ maxParallelSubagents: Type.Integer({ minimum: 1 }), maxDepth: Type.Integer({ minimum: 0 }) },
			{ additionalProperties: false },
		),
		skills: Type.Object(
			{
				dirs: Type.Array(Type.String({ minLength: 1 })),
				pins: Type.Record(
					Type.String(),
					Type.Object(
						{ model: Type.Optional(Type.String({ minLength: 1 })), effort: Type.Optional(EffortSchema) },
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
		tools: Type.Object(
			{
				policy: Type.Record(Type.String(), PolicyActionSchema),
				rules: Type.Array(ToolRuleSchema),
				nonInteractiveAsk: NonInteractiveAskSchema,
				bashTimeoutMs: Type.Integer({ minimum: 1000 }),
			},
			{ additionalProperties: false },
		),
		mcp: Type.Object(
			{
				/** Stdio MCP servers by name; their tools reach the agent as `mcp__<name>__<tool>`. */
				servers: Type.Record(
					Type.String(),
					Type.Object(
						{
							command: Type.String({ minLength: 1 }),
							args: Type.Optional(Type.Array(Type.String())),
							env: Type.Optional(Type.Record(Type.String(), Type.String())),
							timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
						},
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
		pricingOverrides: Type.Record(
			Type.String(),
			Type.Object(
				{
					input: Type.Number({ minimum: 0 }),
					output: Type.Number({ minimum: 0 }),
					cacheRead: Type.Optional(Type.Number({ minimum: 0 })),
					cacheWrite: Type.Optional(Type.Number({ minimum: 0 })),
				},
				{ additionalProperties: false },
			),
		),
		redaction: Type.Object({ patterns: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
		memory: Type.Object(
			{
				enabled: Type.Boolean(),
				maxTokens: Type.Integer({ minimum: 0 }),
				weights: Type.Object(
					{ relevance: Type.Number({ minimum: 0 }), importance: Type.Number({ minimum: 0 }), recency: Type.Number({ minimum: 0 }) },
					{ additionalProperties: false },
				),
				tauDays: Type.Number({ exclusiveMinimum: 0 }),
				topK: Type.Integer({ minimum: 1, maximum: 200 }),
			},
			{ additionalProperties: false },
		),
		learning: Type.Object(
			{
				enabled: Type.Boolean(),
				maxPlaybookItems: Type.Integer({ minimum: 1, maximum: 500 }),
				perJobUsd: Usd,
				staleMinutes: Type.Integer({ minimum: 1 }),
				drainAfterRunMs: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
		optimize: Type.Object(
			{
				/** Fewest eval cases an optimization starts with (spec §8.2.1). */
				minCases: Type.Integer({ minimum: 3 }),
				/** Iterations without a new Pareto member before the loop stops. */
				patience: Type.Integer({ minimum: 1 }),
				/** Lowest judge Cohen's κ that lets judge-only evidence promote a candidate. */
				minJudgeKappa: Type.Number({ minimum: -1, maximum: 1 }),
			},
			{ additionalProperties: false },
		),
		telemetry: Type.Optional(LooseSection),
		ui: Type.Optional(LooseSection),
	},
	{ additionalProperties: false },
);

export type NexoConfig = Static<typeof ConfigSchema>;

export type DeepPartial<T> = T extends readonly (infer _U)[]
	? T
	: T extends object
		? { [K in keyof T]?: DeepPartial<T[K]> }
		: T;

/** Every default from spec §9 except `models`, which the user must provide. */
export const DEFAULT_CONFIG: Omit<NexoConfig, "models"> = {
	providers: {},
	router: { policy: "artifact:router_policy", maxEscalations: 1 },
	scoring: {
		enabled: true,
		scorers: [],
		rubric: "artifact:judge_rubric",
		passThreshold: 0.6,
		commandTimeoutMs: 120_000,
		subagents: false,
	},
	budgets: {
		perRunUsd: 0.5,
		perSessionUsd: 5,
		dailyUsd: 10,
		monthlyUsd: 150,
		optimDefaultUsd: 5,
		escalationCutoff: 0.8,
		estimateOutputTokens: 4096,
	},
	session: { compactAt: 0.8 },
	spawn: { maxParallelSubagents: 4, maxDepth: 4 },
	skills: { dirs: ["$NEXO_HOME/skills", "./.nexo/skills"], pins: {} },
	tools: {
		policy: { read: "allow", write: "allow", edit: "allow", bash: "ask", web_fetch: "ask", load_skill: "allow", spawn: "allow" },
		rules: [],
		nonInteractiveAsk: "deny",
		bashTimeoutMs: 120_000,
	},
	mcp: { servers: {} },
	pricingOverrides: {},
	redaction: { patterns: [] },
	memory: { enabled: true, maxTokens: 1500, weights: { relevance: 1, importance: 0.5, recency: 0.3 }, tauDays: 14, topK: 20 },
	learning: { enabled: true, maxPlaybookItems: 50, perJobUsd: 0.15, staleMinutes: 10, drainAfterRunMs: 30_000 },
	optimize: { minCases: 10, patience: 5, minJudgeKappa: 0.6 },
};
