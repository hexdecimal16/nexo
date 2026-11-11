---
name: wiki
description: Create and maintain a persistent wiki of HTML pages on one topic in the user's wikis directory (Karpathy's LLM-wiki pattern). Use it to start a wiki, ingest a source (article, paper, notes, research results) into it, answer a question from it, or health-check it. Load it before reading or writing any wiki.
metadata:
  nexo-parallel-safe: "false"
---

# Wiki

A wiki is a folder of interlinked HTML pages that you build and keep current for the user. Knowledge is compiled once, when a source arrives, instead of being rediscovered on every question. You write and maintain the pages. The user brings sources and asks questions.

The wikis directory is named in your system prompt. Each wiki is one folder in it, named for its topic in lowercase with hyphens: `<wikis>/<name>/`. Reach it with absolute paths in `read`, `write`, `edit` and `bash`. Never put wiki pages in the run workspace and never touch other nexo files.

If the user does not name a wiki, list the wikis directory and pick the one that fits the topic. If none fits and the task produced durable subject knowledge worth keeping, create a new wiki without asking and tell the user its name and why. Do not create a wiki for a one-off question or for knowledge about how you should behave (that belongs to memories and playbooks).

The wiki holds knowledge about a subject. Lessons about how you should behave next time belong to nexo's memories and playbooks, which you do not edit. Do not copy the same fact into both.

## Layout

```
<name>/
  AGENTS.md    this wiki's schema: purpose, conventions, extra folders
  index.html    catalog: one line per page (link, summary, date), grouped by folder
  log.md       append-only record of operations
  raw/         immutable sources; read them, never edit them (raw/assets/ for images)
  sources/     one summary page per raw source
  entities/    people, organisations, tools, places
  concepts/    ideas, methods, themes
  analyses/    answers and comparisons worth keeping
  overview.html the evolving top-level synthesis
```

## Areas

`<wikis>/areas.json` lists the user's life areas (for example work, builds, research). Each area has a scope note, aliases and the wikis it holds. The user approves every area.

- Before creating a wiki, read `areas.json` and pick the area whose scope fits. Put the new wiki's name in that area's `wikis` list.
- Never add, rename, merge or approve an area. If nothing fits, say so in your answer; the post-run step queues it and proposes a new area once three tasks need it.
- Do not write `feed.jsonl` or `decisions.jsonl`; the post-run step writes them after the run is scored.

## Page rules

- Each page is one self-contained HTML file: inline CSS, no external files, no script elements unless the user asks for interactivity. The head holds <meta name="summary" content="...">, <meta name="updated" content="YYYY-MM-DD"> and <meta name="sources" content="...">.
- Write for a human who reads the page once: open with a <div class="tldr"> that answers in two or three sentences, then h2 sections, tables for comparisons, <details> for side detail, and inline SVG for flows.
- Pages written earlier as .md stay valid and are still read. When you edit one, convert it to .html and delete the .md in the same commit.
- Link pages with relative hrefs such as <a href="../concepts/slug.html">. One topic per page.
- Search before you write (`grep -ril`, then read `index.html`) and update the existing page instead of adding a near-duplicate.
- When a fact changes, replace it and note what changed. Do not leave two claims that contradict each other.
- Date facts and say where they came from.
- Split a page that grows past about 150 lines.

## Create a wiki

1. Create the wiki directory and initial files (`write` creates parent folders automatically, or use `mkdir -p` and `git -C <wiki> init`).
2. Write `AGENTS.md` (topic, one-line purpose, the layout and page rules above, any extra folders), `index.html` (a title and an empty section per folder), `log.md` and `overview.html`.
3. Log and commit (below).

## Ingest a source

1. Put the source in `raw/` (copy a file, or save the fetched text). Do not edit it afterwards.
2. Read it. Tell the user the key takeaways in a few lines and what you plan to emphasise.
3. Write `sources/<slug>.html`.
4. Update the entity and concept pages it touches, creating the ones that are missing. A single source often touches several pages. Flag where it contradicts an existing claim.
5. Update `overview.html` if the synthesis changed, and add or refresh the pages' lines in `index.html`.
6. Log and commit.

## Answer a question

Read `index.html` first, open the pages it points to, and answer with citations to those pages. If the answer is worth keeping (a comparison, an analysis, a connection), offer to file it as `analyses/<slug>.html`. Once the user agrees, write it, update the index, then log and commit. If the wiki cannot answer, say what is missing instead of guessing.

## Lint

Check for contradictions between pages, claims a newer source supersedes, orphan pages with no inbound links, dead links, concepts mentioned often without a page of their own, pages past the size guidance, and index lines that no longer match a page's summary. Report the findings first. Fix only what the user approves, or what is mechanical (dead links, index lines). Log the pass and commit.

## Log and commit

Append one line to `log.md` for each operation, with this prefix so `grep` can read it: `## [YYYY-MM-DD] ingest | Title` (operations: create, ingest, query, lint). Use `date +%F` for the date. Then commit:

```
git -C <wiki> add -A && git -c user.name=nexo -c user.email=nexo@localhost commit -m "ingest: Title"
```

If git is missing or the commit fails, say so and carry on; the pages are still saved.
