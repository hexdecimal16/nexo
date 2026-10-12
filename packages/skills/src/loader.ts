import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Effort, isEffort } from "@nexo/router";
import { type ErrorPayload, NexoError, toErrorPayload } from "@nexo/telemetry";
import { parseSkillFile } from "./frontmatter.ts";

export interface SkillMeta {
	model?: string;
	effort?: Effort;
	modelAllowed: string[];
	escalate: boolean;
	parallelSafe: boolean;
	scorers?: string;
}

export interface Skill {
	name: string;
	description: string;
	dir: string;
	filePath: string;
	body: string;
	content: string;
	meta: SkillMeta;
}

export interface SkillDiagnostic {
	path: string;
	error: ErrorPayload;
}

export interface SkillCatalog {
	skills: Map<string, Skill>;
	diagnostics: SkillDiagnostic[];
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Skills shipped with nexo; load it before the configured dirs so a user skill of the same name replaces one. */
export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("../bundled", import.meta.url));

function invalid(filePath: string, message: string): NexoError {
	return new NexoError({ code: "SKILL_INVALID", message: `${filePath}: ${message}`, context: { filePath } });
}

function parseBool(filePath: string, key: string, value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (value === "true") return true;
	if (value === "false") return false;
	throw invalid(filePath, `metadata.${key} must be "true" or "false"`);
}

function parseMeta(filePath: string, raw: unknown): SkillMeta {
	if (raw === undefined) return { modelAllowed: ["s1", "s2"], escalate: true, parallelSafe: true };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid(filePath, "metadata must be a mapping");
	const meta: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value !== "string") throw invalid(filePath, `metadata.${key} must be a string`);
		meta[key] = value;
	}
	const effort = meta["nexo-effort"];
	if (effort !== undefined && !isEffort(effort)) throw invalid(filePath, `metadata.nexo-effort "${effort}" is not a valid effort`);
	const allowed = (meta["nexo-model-allowed"] ?? "s1,s2")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const result: SkillMeta = {
		modelAllowed: allowed,
		escalate: parseBool(filePath, "nexo-escalate", meta["nexo-escalate"], true),
		parallelSafe: parseBool(filePath, "nexo-parallel-safe", meta["nexo-parallel-safe"], true),
	};
	if (meta["nexo-model"] !== undefined) result.model = meta["nexo-model"];
	if (effort !== undefined) result.effort = effort;
	if (meta["nexo-scorers"] !== undefined) result.scorers = meta["nexo-scorers"];
	return result;
}

function loadSkill(dir: string): Skill {
	const filePath = join(dir, "SKILL.md");
	const content = readFileSync(filePath, "utf8");
	const { frontmatter, body } = parseSkillFile(content, filePath);
	const name = frontmatter.name;
	if (typeof name !== "string" || name.length > 64 || !NAME.test(name)) {
		throw invalid(filePath, "name must be 1-64 chars of lowercase letters, digits and single hyphens");
	}
	if (name !== basename(dir)) throw invalid(filePath, `name "${name}" must match directory "${basename(dir)}"`);
	const description = frontmatter.description;
	if (typeof description !== "string" || description.length === 0 || description.length > 1024) {
		throw invalid(filePath, "description must be a non-empty string of at most 1024 characters");
	}
	return { name, description, dir, filePath, body, content, meta: parseMeta(filePath, frontmatter.metadata) };
}

/** Loads `<dir>/<skill>/SKILL.md` for each dir in order; later dirs win on name collisions. Invalid skills become diagnostics. */
export function loadSkills(dirs: readonly string[]): SkillCatalog {
	const catalog: SkillCatalog = { skills: new Map(), diagnostics: [] };
	for (const root of dirs) {
		if (!existsSync(root) || !statSync(root).isDirectory()) continue;
		for (const entry of readdirSync(root).sort()) {
			const dir = join(root, entry);
			try {
				if (!statSync(dir).isDirectory() || !existsSync(join(dir, "SKILL.md"))) continue;
				const skill = loadSkill(dir);
				catalog.skills.set(skill.name, skill);
			} catch (error) {
				catalog.diagnostics.push({ path: join(dir, "SKILL.md"), error: toErrorPayload(error) });
			}
		}
	}
	return catalog;
}

export function formatSkillIndex(catalog: SkillCatalog): string {
	if (catalog.skills.size === 0) return "";
	const lines = [...catalog.skills.values()].map((s) => `- ${s.name}: ${s.description}`);
	return `Available skills (call load_skill before using one):\n${lines.join("\n")}`;
}
