# Trusted Shared Memory

All trusted groups share a common memory tier at `/workspace/trusted/memory/`.

## Writing to shared memory

After any non-trivial interaction in a trusted group, append a one-liner to:
```
/workspace/trusted/memory/daily/YYYY-MM-DD.md
```

Format:
```
- HH:MM UTC [chat-name] — [what happened / what was learned]
```

Where `[chat-name]` is a short identifier for the source group (e.g. `[main]`, `[dedy-bukhtyat]`).

"Non-trivial" = a decision was made, action taken, or something new learned about the owner's preferences or context.

## Reading shared memory

On session bootstrap, trusted groups should also read:
- `/workspace/trusted/memory/daily/` — recent days (last 1–2 files)
- `/workspace/trusted/memory/weekly/` — weekly summaries for older context

This gives each trusted agent awareness of what happened in other trusted chats.

## Archival

Nightly housekeeping (Step 8c) archives trusted daily logs → weekly summaries, and weekly summaries → `trusted/highlights.md` on week boundaries. Source attribution (`[chat-name]`) is preserved throughout.

## Directory structure

```
/workspace/trusted/memory/
  daily/
    YYYY-MM-DD.md   # entries from all trusted groups, with [source] tags
  weekly/
    YYYY-WNN.md     # weekly aggregates
```
