import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyScratchpad, SCRATCHPAD_ENTRIES, type Scratchpad, scratchpadEntry } from "@nexo/optimize";
import { resolveConfined } from "@nexo/tools";

/** The wiki that holds what optimizations learned: one page per target, readable and editable in the Wikis UI. */
export const SCRATCHPAD_WIKI = "optimization";

/** The page of `targetKey` inside the wiki, e.g. `analyses/optim-skill-web-research.md`. */
export function scratchpadPagePath(targetKey: string): string {
	const slug = targetKey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "target";
	return `analyses/optim-${slug}.md`;
}

/** The bullet lines under "Validated patterns" and "Anti-patterns" of a page, newest last, each clipped, at most SCRATCHPAD_ENTRIES per list. */
export function parseScratchpad(markdown: string): Scratchpad {
	const pad = emptyScratchpad();
	let list: string[] | null = null;
	for (const line of markdown.split(/\r?\n/)) {
		if (/^##\s+validated patterns/i.test(line)) list = pad.patterns;
		else if (/^##\s+anti-patterns/i.test(line)) list = pad.antiPatterns;
		else if (/^#/.test(line)) list = null;
		else if (list && /^-\s+\S/.test(line)) list.push(scratchpadEntry(line.replace(/^-\s+/, "")));
	}
	return { patterns: pad.patterns.slice(-SCRATCHPAD_ENTRIES), antiPatterns: pad.antiPatterns.slice(-SCRATCHPAD_ENTRIES) };
}

/** The saved scratchpad of a target, or undefined when there is no page, it has no entries or it cannot be read. */
export function readScratchpad(wikisDir: string, targetKey: string): Scratchpad | undefined {
	try {
		const file = resolveConfined(resolveConfined(wikisDir, SCRATCHPAD_WIKI), scratchpadPagePath(targetKey));
		if (!existsSync(file)) return undefined;
		const pad = parseScratchpad(readFileSync(file, "utf8"));
		return pad.patterns.length + pad.antiPatterns.length > 0 ? pad : undefined;
	} catch {
		return undefined;
	}
}

/** Writes the target's scratchpad page (creating the wiki on first use) and logs it; returns the page file. */
export function writeScratchpad(
	wikisDir: string,
	targetKey: string,
	pad: Scratchpad,
	info: { optimRunId: string; baseVersion: number; today: string; redact: (text: string) => string },
): string {
	const wikiDir = resolveConfined(wikisDir, SCRATCHPAD_WIKI);
	const { today } = info;
	if (!existsSync(wikiDir)) {
		for (const d of ["concepts", "entities", "sources", "analyses", "raw"]) mkdirSync(join(wikiDir, d), { recursive: true });
		writeFileSync(join(wikiDir, "AGENTS.md"), "# optimization wiki\n\nWhat nexo optimizations learned about each target. Pages under analyses/ are read back into the next optimization of the same target.\n");
		writeFileSync(join(wikiDir, "index.md"), "# optimization index\n\n## Concepts\n\n## Entities\n\n## Sources\n\n## Analyses\n");
		writeFileSync(join(wikiDir, "log.md"), `# Log\n\n## [${today}] create | Initialized wiki\n`);
		writeFileSync(join(wikiDir, "overview.md"), `---\nsummary: Overview of optimization\nupdated: ${today}\nsources: []\n---\n\n# optimization\n`);
	}
	const page = scratchpadPagePath(targetKey);
	const file = resolveConfined(wikiDir, page);
	mkdirSync(dirname(file), { recursive: true });
	const bullets = (items: readonly string[]) => (items.length > 0 ? items.map((i) => `- ${info.redact(i)}`).join("\n") : "(none yet)");
	const body = [
		`---\nsummary: Lessons from optimizing ${targetKey}, read back into its next optimization\nupdated: ${today}\nsources: [optim:${info.optimRunId}]\n---`,
		`# Optimization scratchpad: ${targetKey}`,
		`Written by optimization ${info.optimRunId} (base v${info.baseVersion}, ${today}). Edit or delete lines freely: the next optimization of this target reads them as hints, at most ${SCRATCHPAD_ENTRIES} per list.`,
		`## Validated patterns\n${bullets(pad.patterns)}`,
		`## Anti-patterns\n${bullets(pad.antiPatterns)}`,
	].join("\n\n");
	writeFileSync(file, `${body}\n`);
	const log = join(wikiDir, "log.md");
	if (existsSync(log)) writeFileSync(log, `${readFileSync(log, "utf8")}\n## [${today}] ingest | Optimization ${info.optimRunId} updated ${page}\n`);
	return file;
}
