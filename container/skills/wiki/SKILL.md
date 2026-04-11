---
name: wiki
description: Maintain a persistent personal knowledge wiki. Ingest sources (URLs, PDFs, transcripts, images, voice notes), build structured wiki pages, cross-reference, and keep an index. Use on "add to wiki", "wiki ingest", "look up in wiki", "wiki lint", or when the user shares a source and says to remember/file/catalog it.
---

You maintain a personal wiki at `/workspace/trusted/wiki/` with raw sources at `/workspace/trusted/sources/`.

## Three layers

1. **Sources** (`/workspace/trusted/sources/`) — immutable raw material. You read but never modify these.
2. **Wiki** (`/workspace/trusted/wiki/`) — your output. Summaries, entity pages, concept pages, comparisons, syntheses. You own this entirely.
3. **Schema** (this file) — how you maintain the wiki.

## Three operations

### Ingest

When the user provides a source (URL, file, text, image, voice note):

1. **Save the raw source** to `/workspace/trusted/sources/`. For URLs, download the full content:
   ```bash
   curl -sLo /workspace/trusted/sources/filename.pdf "<url>"
   ```
   For web pages, use WebFetch or browser to get full text. Never rely on summaries — get the complete document.

2. **Read and discuss** — summarize key takeaways with the user. Don't rush to filing.

3. **Create/update wiki pages** — one source at a time, never batch:
   - Summary page for the source
   - Update or create entity pages (people, tools, companies, conferences)
   - Update or create concept pages (methodologies, patterns, technologies)
   - Add cross-references between related pages
   - Flag contradictions with existing wiki content

4. **Update index.md** — add the new pages with one-line summaries, organized by category.

5. **Append to log.md** — `## [YYYY-MM-DD] ingest | Source Title`

**Ingest discipline:** When given multiple sources, process them ONE AT A TIME. Read, discuss, create all wiki pages, finish completely, then move to the next. Batch processing produces shallow, generic pages.

### Query

When the user asks a question:

1. Read `wiki/index.md` first to locate relevant pages.
2. Read the relevant pages.
3. Synthesize an answer with citations to wiki pages.
4. If the answer is substantial and reusable, offer to file it as a new wiki page (explorations compound rather than disappearing into chat).

### Lint

Periodic health check. Look for:
- Contradictions between pages
- Stale claims superseded by newer sources
- Orphan pages with no inbound links
- Important concepts mentioned but lacking dedicated pages
- Missing cross-references
- Gaps — topics referenced but never sourced

Report findings and offer to fix.

## Page format

Use markdown with YAML frontmatter:

```markdown
---
title: Page Title
type: entity | concept | summary | synthesis | comparison
sources: [source1.md, source2.pdf]
related: [other-page.md, another.md]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

Content here. Link to related pages: [Related Topic](related-topic.md)
```

## Categories

Categories emerge from the content. Don't force a taxonomy. As patterns appear, organize into directories:
- `wiki/devrel/` — conferences, CFPs, speaking, DevRel strategy
- `wiki/tech/` — AI, spec-driven dev, tooling, Java/JVM
- `wiki/personal/` — smart home, travel, projects
- `wiki/people/` — entity pages for key people

Create subdirectories when a category exceeds ~10 pages.

## Relationship with memory

Memory (`/workspace/trusted/MEMORY.md`) = operational context (preferences, feedback, project state).
Wiki (`/workspace/trusted/wiki/`) = accumulated domain knowledge.

When ingesting, if you learn something that's operational (a preference, a correction), put it in memory. If it's domain knowledge (a fact, a concept, a synthesis), put it in the wiki. When answering questions, check both.
