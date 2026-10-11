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
const ModelRefSchema = Type.Object({ ref: Type.Union([Type.Literal("s1"), Type.Literal("s2")]) }, { additionalProperties: false });
const PolicyActionSchema = Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")]);
const LooseSection = Type.Object({}, { additionalProperties: true });
const Usd = Type.Number({ exclusiveMinimum: 0 });

export const ConfigSchema = Type.Object(
	{
		models: Type.Object(
			{
				s1: ModelSpecSchema,
				s2: ModelSpecSchema,
				judge: Type.Optional(Type.Array(ModelSpecSchema)),
				reflector: Type.Optional(Type.Union([ModelSpecSchema, ModelRefSchema])),
				embedding: Type.Optional(ModelSpecSchema),
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
				},
				{ additionalProperties: false },
			),
		),
		router: Type.Object(
			{ policy: Type.String({ minLength: 1 }), maxEscalations: Type.Integer({ minimum: 0 }) },
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
				rules: Type.Array(
					Type.Object(
						{ tool: Type.String({ minLength: 1 }), match: Type.Optional(Type.String()), action: PolicyActionSchema },
						{ additionalProperties: false },
					),
				),
				nonInteractiveAsk: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
				bashTimeoutMs: Type.Integer({ minimum: 1000 }),
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
		memory: Type.Optional(LooseSection),
		learning: Type.Optional(LooseSection),
		optimize: Type.Optional(LooseSection),
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
	pricingOverrides: {},
	redaction: { patterns: [] },
};
