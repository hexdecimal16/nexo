import { readFileSync } from "node:fs";
import { NexoError } from "@nexo/telemetry";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";

const Name = Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_.:-]+$" }));

/** Longest `regex` scorer pattern accepted; patterns run on agent output in the engine process. */
export const MAX_REGEX_PATTERN_CHARS = 1000;

export const ScorerSpecSchema = Type.Union([
	Type.Object(
		{ kind: Type.Literal("command"), name: Name, command: Type.String({ minLength: 1 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 100 })) },
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("json_schema"), name: Name, schema: Type.Object({}, { additionalProperties: true }) }, { additionalProperties: false }),
	Type.Object(
		{
			kind: Type.Literal("regex"),
			name: Name,
			pattern: Type.String({ minLength: 1, maxLength: MAX_REGEX_PATTERN_CHARS }),
			flags: Type.Optional(Type.String({ pattern: "^[imsu]*$" })),
			negate: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("contains"), name: Name, text: Type.String({ minLength: 1 }), ignoreCase: Type.Optional(Type.Boolean()), negate: Type.Optional(Type.Boolean()) },
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("llm_judge"), name: Name, rubric: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("human"), name: Name }, { additionalProperties: false }),
]);

export type ScorerSpec = Static<typeof ScorerSpecSchema>;
export type ScorerSpecKind = ScorerSpec["kind"];

export const SCORER_SPEC_KINDS: readonly ScorerSpecKind[] = ["command", "json_schema", "regex", "contains", "llm_judge", "human"];

/** The name a spec's score is recorded under: its `name`, else its kind. */
export function scorerName(spec: ScorerSpec): string {
	return spec.name ?? spec.kind;
}

const JSON_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];

function resolvePointer(root: unknown, ref: string): boolean {
	let node: unknown = root;
	for (const part of ref.slice(1).split("/").slice(1)) {
		const key = decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof node !== "object" || node === null || !(key in node)) return false;
		node = (node as Record<string, unknown>)[key];
	}
	return true;
}

/** The first problem that would make a JSON Schema unusable: an unknown `type`, an unresolvable local `$ref`, or a pattern that does not compile. */
function schemaProblem(schema: object): string | undefined {
	const walk = (node: unknown, path: string): string | undefined => {
		if (Array.isArray(node)) {
			for (const [i, item] of node.entries()) {
				const found = walk(item, `${path}/${i}`);
				if (found) return found;
			}
			return undefined;
		}
		if (typeof node !== "object" || node === null) return undefined;
		const obj = node as Record<string, unknown>;
		const type = obj.type;
		const types = typeof type === "string" ? [type] : Array.isArray(type) && type.every((t) => typeof t === "string") ? (type as string[]) : [];
		const bad = types.find((t) => !JSON_TYPES.includes(t));
		if (bad !== undefined) return `${path}/type "${bad}" is not a JSON Schema type`;
		const ref = obj.$ref;
		if (typeof ref === "string" && ref.startsWith("#") && !resolvePointer(schema, ref)) return `${path}/$ref ${ref} does not resolve`;
		for (const [key, value] of Object.entries(obj)) {
			const found = walk(value, `${path}/${key}`);
			if (found) return found;
		}
		return undefined;
	};
	const found = walk(schema, "");
	if (found) return found;
	try {
		Compile(schema as never);
	} catch (cause) {
		return (cause as Error).message;
	}
	return undefined;
}

function invalid(source: string, message: string, context: Record<string, unknown> = {}): NexoError {
	return new NexoError({
		code: "CONFIG_INVALID",
		message: `Invalid scorer spec ${source}: ${message}`,
		hint: `Each scorer is an object whose kind is one of ${SCORER_SPEC_KINDS.join(", ")}`,
		context: { source, ...context },
	});
}

/**
 * Validates a list of scorer specs: each against its kind's schema, regex patterns compile, and names are unique.
 * Throws CONFIG_INVALID naming the source and the index of the bad entry.
 */
export function parseScorerSpecs(raw: unknown, source: string): ScorerSpec[] {
	if (!Array.isArray(raw)) throw invalid(source, "expected an array of scorers");
	const names = new Set<string>();
	return raw.map((entry, index) => {
		const kind = typeof entry === "object" && entry !== null ? (entry as { kind?: unknown }).kind : undefined;
		if (typeof kind !== "string" || !(SCORER_SPEC_KINDS as readonly string[]).includes(kind)) {
			throw invalid(source, `/${index}/kind must be one of ${SCORER_SPEC_KINDS.join(", ")}`, { index });
		}
		if (!Value.Check(ScorerSpecSchema, entry)) {
			const branch = ScorerSpecSchema.anyOf.find((s) => s.properties.kind.const === kind);
			const errors = branch ? [...Value.Errors(branch, entry)].map((e) => `/${index}${e.instancePath} ${e.message}`) : [];
			throw invalid(source, errors.join("; ") || `/${index} is not a valid ${kind} scorer`, { index, errors });
		}
		const spec = entry as ScorerSpec;
		if (spec.kind === "regex") {
			try {
				new RegExp(spec.pattern, spec.flags);
			} catch (cause) {
				throw invalid(source, `/${index}/pattern does not compile: ${(cause as Error).message}`, { index });
			}
		}
		if (spec.kind === "json_schema") {
			const problem = schemaProblem(spec.schema);
			if (problem) throw invalid(source, `/${index}/schema is not a usable JSON Schema: ${problem}`, { index });
		}
		const name = scorerName(spec);
		if (names.has(name)) throw invalid(source, `/${index} repeats the scorer name "${name}"; give each scorer a distinct name`, { index });
		names.add(name);
		return spec;
	});
}

/** Reads a skill's `nexo-scorers` file: a JSON array of specs, or `{ "scorers": [...] }`. */
export function loadScorerFile(file: string): ScorerSpec[] {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (cause) {
		throw new NexoError({ code: "CONFIG_INVALID", message: `Cannot read scorer spec ${file}: ${(cause as Error).message}`, context: { file }, cause });
	}
	const list = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as { scorers?: unknown }).scorers : raw;
	return parseScorerSpecs(list, file);
}
