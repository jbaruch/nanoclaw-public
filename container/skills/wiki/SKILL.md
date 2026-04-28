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

Periodic health check. **Self-service by default — do not ask "should I fix?"** The lint is often invoked from scheduled contexts (weekly-housekeeping, heartbeat), where there is no interactive reader on the other end. Hanging on a yes/no prompt silently blocks the whole scheduled cycle — observed on 2026-04-19 when the Sun 4am weekly sent "rebuild?" to Telegram and idled waiting for a reply that never came.

Find:
- Contradictions between pages
- Stale claims superseded by newer sources
- Orphan pages with no inbound links
- Important concepts mentioned but lacking dedicated pages
- Missing cross-references
- Gaps — topics referenced but never sourced

Then act per category — decide, don't ask:

| Category | Action |
|---|---|
| Missing cross-references | **Auto-fix.** Add the inbound/outbound link and update the page's `updated:` frontmatter. Safe — purely additive, reversible. |
| Orphan pages with no inbound links | **Auto-fix.** Add a reference from the nearest category index or hub page and update the page's `updated:` frontmatter. If no natural hub exists, set the frontmatter keys `lint_orphan: YYYY-MM-DD` and `updated:` on the orphan page — these go into the Fixed summary count, not the Report section. |
| Stale claims superseded by newer sources | **Auto-fix** when the newer source is already ingested and the supersession is unambiguous (same entity, clearer numbers/dates, newer `created:`). Strike the stale line, add a Markdown link: `superseded by [Newer Page Title](newer-page.md)`, and update the page's `updated:` frontmatter. Ambiguous cases — different methodology, partial overlap, conflicting primary sources — fall to **Report**. |
| Gaps — topics referenced but never sourced | **Report.** Cannot fix without new source ingestion, which requires human judgment on what to fetch. List the topic and the pages that reference it. |
| Contradictions between pages | **Report.** Requires human judgment on which claim is correct. Never auto-pick. List the contradicting pages and quote the conflicting lines. |
| Important concepts mentioned but lacking dedicated pages | **Report.** Creating a concept page is a judgment call about scope and depth — don't synthesize without a source pointer. |

**Output** — write a single summary to stdout (if run from CLI) or one `send_message` (if run from a skill context), never a paired question:

```
Wiki lint — YYYY-MM-DD
Fixed: <fixed_crossrefs> cross-refs added, <fixed_orphans> orphans hub-linked, <fixed_superseded> stale lines superseded
Report: <report_gaps> gaps, <report_contradictions> contradictions, <report_missing_concepts> missing concept pages
[details follow as bullets if any Report-category hits]
```

If nothing to fix and nothing to report → silence. Do NOT emit "wiki is clean" or any acknowledgment.

**Rationale for acting over asking.** The three auto-fix categories are each reversible via git (the wiki lives under version control) and produce no semantic conflicts: missing cross-refs are discovered links, orphan hub-linking places a page where a reader can find it, and unambiguous supersession strikes an already-superseded fact. The three report-only categories involve choices (which source to trust, how deep a concept page should go, whether to ingest a new source) that belong to the wiki owner, not to a scheduled job at 4am.

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
# Optional lint-state keys (set by the self-service lint, not by ingest):
# lint_orphan: YYYY-MM-DD    # set when an orphan page has no natural hub
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
