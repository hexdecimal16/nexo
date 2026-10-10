import { NexoError } from "@nexo/telemetry";
import { parse } from "yaml";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillFile(text: string, filePath: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = FRONTMATTER.exec(text);
	if (!match) {
		throw new NexoError({ code: "SKILL_INVALID", message: `${filePath}: missing YAML frontmatter`, context: { filePath } });
	}
	let data: unknown;
	try {
		data = parse(match[1] ?? "");
	} catch (cause) {
		throw new NexoError({
			code: "SKILL_INVALID",
			message: `${filePath}: invalid YAML frontmatter: ${(cause as Error).message}`,
			context: { filePath },
			cause,
		});
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new NexoError({ code: "SKILL_INVALID", message: `${filePath}: frontmatter must be a mapping`, context: { filePath } });
	}
	return { frontmatter: data as Record<string, unknown>, body: match[2] ?? "" };
}
