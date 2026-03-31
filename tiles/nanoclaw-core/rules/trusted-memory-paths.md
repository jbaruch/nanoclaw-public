# Trusted Memory Paths

Persistent shared memory that applies to all trusted groups lives in `/workspace/trusted/`. This directory is mounted in trusted and main containers but NOT in untrusted containers.

Key files in `/workspace/trusted/`:
- `MEMORY.md` — permanent facts and feedback rules index
- `key-people.md` — known contacts with Telegram usernames
- `feedback_*.md` — behavioral preferences and feedback rules
- `trusted_senders.md` — trusted sender identifiers
- `credentials_scope.md` — available credentials scope
- `project_*.md` — ongoing project status files
- `highlights.md` — major long-term events

Group-specific memory (daily logs, weekly summaries) stays in `/workspace/group/memory/daily/` and `/workspace/group/memory/weekly/`.

Session bootstrap reads from `/workspace/trusted/MEMORY.md` and the most recent daily/weekly files.
