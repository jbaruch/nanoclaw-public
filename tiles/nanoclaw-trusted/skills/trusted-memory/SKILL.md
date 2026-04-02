---
name: trusted-memory
description: Session bootstrap and rolling memory updates for trusted containers. On session start, reads MEMORY.md (permanent facts), RUNBOOK.md (operational workflows), recent daily and weekly logs, and highlights.md to restore context. After non-trivial interactions, appends timestamped entries to group-local and cross-group shared daily logs. Use when starting a new session to load previous notes and remember context, or after meaningful conversations to save conversation history, persist session state, or record newly learned owner preferences.
---

# Trusted Memory

This rule applies to trusted and main containers only. `/workspace/trusted/` is mounted here. Untrusted containers do not have this mount.

## Directory Structure

```
/workspace/trusted/                    # Shared across all trusted containers
  MEMORY.md                            # Permanent facts and feedback rules index
  RUNBOOK.md                           # Operational workflows and tool knowledge
  key-people.md                        # Known contacts with Telegram usernames
  highlights.md                        # Major long-term events
  feedback_*.md                        # Behavioral preferences and feedback rules
  project_*.md                         # Ongoing project status files
  trusted_senders.md                   # Trusted sender identifiers
  credentials_scope.md                 # Available credentials scope
  memory/
    daily/YYYY-MM-DD.md                # Cross-group shared entries with [source] tags
    weekly/YYYY-WNN.md                 # Weekly aggregates
    daily_discoveries.md               # Operational learnings (see daily-discoveries-rule)

/workspace/group/memory/               # Group-local, not shared
  daily/YYYY-MM-DD.md                  # Full detail for this group only
  weekly/YYYY-WNN.md                   # Weekly summaries for this group
```

## Session Bootstrap

On first interaction in a new session (check if session ID in `session-state.json` differs from current):

1. Read `/workspace/trusted/MEMORY.md` — permanent facts and feedback rules
2. Read `/workspace/trusted/RUNBOOK.md` — operational workflows and tool knowledge
3. Read the most recent 2 files from `/workspace/group/memory/daily/` in full (yesterday + today)
4. Read the most recent 2 files from `/workspace/group/memory/weekly/` as summaries (older context)
5. Read the most recent 2 files from `/workspace/trusted/memory/daily/` (cross-group shared memory)
6. Read `/workspace/trusted/highlights.md` if it exists (major long-term events)
7. Update `session-state.json` with the current session ID

Total context budget for memory: ~3000 tokens. Summarize large files before loading.

### Bootstrap Error Handling

- **Missing files**: If any file does not exist (e.g. first-ever session, no daily logs yet), skip it silently and continue with the remaining steps. Do not treat absence as an error.
- **Missing `session-state.json`**: Treat this as a fresh session — proceed through all bootstrap steps and create the file with the current session ID at step 7.
- **Corrupt or unreadable `session-state.json`**: Treat as missing — overwrite with the current session ID after completing bootstrap.
- **Missing or empty daily/weekly directories**: Skip those steps and proceed. Note in the first rolling memory update that this is a new memory store.

## Rolling Memory Updates

After any non-trivial interaction (decision made, action taken, something new learned about the owner's preferences):

**Group-local log** — append to `/workspace/group/memory/daily/YYYY-MM-DD.md`:
```
- HH:MM UTC — [what happened / what was learned]
```

**Cross-group shared log** — also append to `/workspace/trusted/memory/daily/YYYY-MM-DD.md` with source attribution:
```
- HH:MM UTC [chat-name] — [what happened / what was learned]
```
Where `[chat-name]` is derived from the group folder name (e.g. `main`, `swarm`, `dedy-bukhtyat`).

Skip for pure heartbeats with nothing to report or trivial acknowledgements.

## Archival

Nightly housekeeping archives daily logs → weekly summaries, and weekly summaries → `highlights.md` on week boundaries. Source attribution (`[chat-name]`) is preserved throughout. This applies to both group-local and shared trusted logs.

Archival is triggered by the nightly housekeeping process (not by Claude during a normal session). Weekly summaries follow the same bullet format as daily logs but group related entries thematically. On week boundaries, the weekly summary is condensed into a short paragraph appended to `highlights.md`.
