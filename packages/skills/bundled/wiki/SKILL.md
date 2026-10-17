---
name: wiki
description: Create and maintain a persistent markdown wiki on one topic in the user's wikis directory (Karpathy's LLM-wiki pattern). Use it to start a wiki, ingest a source (article, paper, notes, research results) into it, answer a question from it, or health-check it. Load it before reading or writing any wiki.
metadata:
  nexo-parallel-safe: "false"
---

# Wiki

A wiki is a folder of interlinked markdown pages that you build and keep current for the user. Knowledge is compiled once, when a source arrives, instead of being rediscovered on every question. You write and maintain the pages. The user brings sources and asks questions.

The wikis directory is named in your system prompt. Each wiki is one folder in it, named for its topic in lowercase with hyphens: `<wikis>/<name>/`. Reach it with absolute paths in `read`, `write`, `edit` and `bash`. Never put wiki pages in the run workspace and never touch other nexo files.

If the user does not name a wiki, list the wikis directory and pick the one that fits the topic. If none fits, say so and ask before creating one.

The wiki holds knowledge about a subject. Lessons about how you should behave next time belong to nexo's memories and playbooks, which you do not edit. Do not copy the same fact into both.

## Layout

```
<name>/
  AGENTS.md    this wiki's schema: purpose, conventions, extra folders
  index.md     catalog: one line per page (link, summary, date), grouped by folder
  log.md       append-only record of operations
  raw/         immutable sources; read them, never edit them (raw/assets/ for images)
  sources/     one summary page per raw source
  entities/    people, organisations, tools, places
  concepts/    ideas, methods, themes
  analyses/    answers and comparisons worth keeping
  overview.md  the evolving top-level synthesis
```

## Page rules

- Each page starts with a frontmatter block (between two `---` lines) holding `summary:` (one specific line), `updated:` (YYYY-MM-DD) and `sources:` (raw files or URLs).
- Link pages as `[[folder/slug]]`. One topic per page.
- Search before you write (`grep -ril`, then read `index.md`) and update the existing page instead of adding a near-duplicate.
- When a fact changes, replace it and note what changed. Do not leave two claims that contradict each other.
- Date facts and say where they came from.
- Split a page that grows past about 150 lines.

## Create a wiki

1. `mkdir -p` the folders above and run `git -C <wiki> init`.
2. Write `AGENTS.md` (topic, one-line purpose, the layout and page rules above, any extra folders), `index.md` (a title and an empty section per folder), `log.md` and `overview.md`.
3. Log and commit (below).

## Ingest a source

1. Put the source in `raw/` (copy a file, or save the fetched text). Do not edit it afterwards.
2. Read it. Tell the user the key takeaways in a few lines and what you plan to emphasise.
3. Write `sources/<slug>.md`.
4. Update the entity and concept pages it touches, creating the ones that are missing. A single source often touches several pages. Flag where it contradicts an existing claim.
5. Update `overview.md` if the synthesis changed, and add or refresh the pages' lines in `index.md`.
6. Log and commit.

## Answer a question

Read `index.md` first, open the pages it points to, and answer with citations to those pages. If the answer is worth keeping (a comparison, an analysis, a connection), offer to file it as `analyses/<slug>.md`. Once the user agrees, write it, update the index, then log and commit. If the wiki cannot answer, say what is missing instead of guessing.

## Lint

Check for contradictions between pages, claims a newer source supersedes, orphan pages with no inbound links, dead links, concepts mentioned often without a page of their own, pages past the size guidance, and index lines that no longer match a page's summary. Report the findings first. Fix only what the user approves, or what is mechanical (dead links, index lines). Log the pass and commit.

## Log and commit

Append one line to `log.md` for each operation, with this prefix so `grep` can read it: `## [YYYY-MM-DD] ingest | Title` (operations: create, ingest, query, lint). Use `date +%F` for the date. Then commit:

```
git -C <wiki> add -A && git -c user.name=nexo -c user.email=nexo@localhost commit -m "ingest: Title"
```

If git is missing or the commit fails, say so and carry on; the pages are still saved.
