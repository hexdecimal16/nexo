import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { dataBlock } from "@nexo/scorers";
import { findHomeFolder, listHomeFolders, resolveConfined, UNSORTED_AREA, wrapWikiHtml } from "@nexo/tools";
import { type Static, Type } from "typebox";
import type { RunRow, SpanRow } from "@nexo/store";
import { type ChargedCallDeps, structuredLearnCall } from "./caller.ts";

function titleFromPath(path: string): string {
	const base = path.split("/").pop() ?? path;
	return base.replace(/[.]html$/, "").replace(/-/g, " ");
}

export const WikiPageProposalSchema = Type.Object(
	{
		wikiName: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" }),
		path: Type.String({ minLength: 1, maxLength: 128 }),
		summary: Type.String({ minLength: 1, maxLength: 300 }),
		content: Type.String({ minLength: 1, maxLength: 8000 }),
	},
	{ additionalProperties: false },
);

export const WikiCurationSchema = Type.Object(
	{
		pages: Type.Array(WikiPageProposalSchema, { maxItems: 4 }),
	},
	{ additionalProperties: false },
);

export type WikiCuration = Static<typeof WikiCurationSchema>;

export const WIKI_CURATOR_SYSTEM = `You are a knowledge curator for an AI agent's persistent wikis of HTML pages.
Review the finished task and its output. Determine if the task produced substantive, durable subject knowledge (research results, domain concepts, entity profiles, method syntheses, technical facts) that should be recorded into a wiki for future reference.

Do NOT create wiki pages for:
- Routine code modifications, git operations or minor debugging
- One-off conversational chit-chat or simple user preference statements (which belong to memories)
- Ephemeral task artifacts

If durable subject knowledge is present:
- Select an appropriate wiki topic name in lowercase-with-hyphens (e.g. "ai", "finance", "distributed-systems").
- Propose pages using appropriate subfolders: "concepts/<slug>.html", "entities/<slug>.html", "sources/<slug>.html", or "analyses/<slug>.html".
- Provide a concise summary and the page content as an HTML body fragment for a human reader: no html, head, body or script elements. Start with <div class="tldr"> giving the answer in two or three sentences, then h2 sections, tables, <details> for side detail, and inline SVG for diagrams where they help. Link other pages with relative hrefs such as <a href="../concepts/slug.html">. Escape text as HTML.
If no substantive subject knowledge is worth saving, reply with {"pages": []}.`;

export function wikiCuratorPrompt(input: {
	instruction: string;
	output: string;
	existingWikis: string[];
}): string {
	const wikisList = input.existingWikis.length > 0 ? input.existingWikis.join(", ") : "(no existing wikis)";
	return [
		`# Existing wikis\n${wikisList}`,
		`# User instruction\n${dataBlock("instruction", input.instruction)}`,
		`# Final output\n${dataBlock("output", input.output || "(empty)")}`,
	].join("\n\n");
}

export interface WikiCurateResult {
	pagesCreated: number;
	wikisTouched: string[];
	/** Created pages relative to the wikis dir, e.g. ai/concepts/raft.html. */
	pages: string[];
}

/**
 * Curates durable subject knowledge into persistent markdown wikis after a run.
 */
export async function curateWikiKnowledge(
	deps: ChargedCallDeps,
	run: RunRow,
	output: string,
	spans: readonly SpanRow[],
): Promise<WikiCurateResult> {
	const wikisDir = deps.env.deps.paths?.homeRoot;
	if (!wikisDir) return { pagesCreated: 0, wikisTouched: [], pages: [] };
	if (!existsSync(wikisDir)) mkdirSync(wikisDir, { recursive: true });

	// Skip if the run itself explicitly loaded the wiki skill (it managed its own wiki edits)
	const usedWikiSkill = spans.some((s) => s.kind === "skill_load" && s.status === "ok" && (s.attrs.args as { name?: string } | undefined)?.name === "wiki");
	if (usedWikiSkill) return { pagesCreated: 0, wikisTouched: [], pages: [] };

	// Only evaluate runs that have non-trivial instruction/output
	if (!output || output.trim().length < 50) return { pagesCreated: 0, wikisTouched: [], pages: [] };

	let existingWikis: string[] = [];
	try {
		existingWikis = readdirSync(wikisDir).filter((f) => {
			if (f.startsWith(".")) return false;
			try {
				return statSync(join(wikisDir, f)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		existingWikis = [];
	}

	existingWikis = listHomeFolders(wikisDir).map((f) => f.name);
	const prompt = wikiCuratorPrompt({
		instruction: run.instruction,
		output,
		existingWikis,
	});

	const curation = await structuredLearnCall(deps, WikiCurationSchema, {
		system: WIKI_CURATOR_SYSTEM,
		user: prompt,
		tier: "curator",
	});

	if (curation.pages.length === 0) return { pagesCreated: 0, wikisTouched: [], pages: [] };

	let pagesCreated = 0;
	const createdPages: string[] = [];
	const wikisTouched = new Set<string>();
	const today = deps.env.now().toISOString().slice(0, 10);

	for (const p of curation.pages) {
		try {
			const wikiDir = findHomeFolder(wikisDir, p.wikiName)?.dir ?? resolveConfined(wikisDir, `${UNSORTED_AREA}/${p.wikiName}`);
			if (!existsSync(wikiDir)) {
				mkdirSync(wikiDir, { recursive: true });
				mkdirSync(join(wikiDir, "concepts"), { recursive: true });
				mkdirSync(join(wikiDir, "entities"), { recursive: true });
				mkdirSync(join(wikiDir, "sources"), { recursive: true });
				mkdirSync(join(wikiDir, "analyses"), { recursive: true });
				mkdirSync(join(wikiDir, "raw"), { recursive: true });
				writeFileSync(
					join(wikiDir, "AGENTS.md"),
					`# ${p.wikiName} wiki\n\nKnowledge base for ${p.wikiName}.\n`,
				);
				writeFileSync(join(wikiDir, "index.html"), wrapWikiHtml({ title: `${p.wikiName} index`, summary: `Index of the ${p.wikiName} wiki`, updated: today, sources: [], body: "<p>No pages yet.</p>" }));
				writeFileSync(join(wikiDir, "log.md"), `# Log\n\n## [${today}] create | Initialized wiki\n`);
				writeFileSync(join(wikiDir, "overview.html"), wrapWikiHtml({ title: `${p.wikiName} overview`, summary: `Overview of the ${p.wikiName} wiki`, updated: today, sources: [], body: "<p>No synthesis yet.</p>" }));
			}

			const pagePath = `${p.path.replace(/[.](md|html)$/, "")}.html`;
			const targetFile = resolveConfined(wikiDir, pagePath);
			mkdirSync(dirname(targetFile), { recursive: true });

			const pageHtml = wrapWikiHtml({ title: titleFromPath(pagePath), summary: p.summary, updated: today, sources: [`run:${run.id}`], body: p.content });
			writeFileSync(targetFile, pageHtml);
			pagesCreated++;
			createdPages.push(relative(wikisDir, targetFile).split(sep).join("/"));
			wikisTouched.add(p.wikiName);

			const logFile = join(wikiDir, "log.md");
			if (existsSync(logFile)) {
				const logLine = `\n## [${today}] ingest | Auto-curated ${p.path} from run ${run.id}\n`;
				writeFileSync(logFile, readFileSync(logFile, "utf8") + logLine);
			}
		} catch (err) {
			deps.env.deps.logger.warn("failed to write curated wiki page", { wiki: p.wikiName, path: p.path, error: err });
		}
	}

	return { pagesCreated, wikisTouched: [...wikisTouched], pages: createdPages };
}
