# Skill Dependencies

Skills that invoke or depend on other skills. Read this to understand execution order and shared state.

## Heartbeat (runs every 15 min)
1. Calls `task-tz-sync` (Step 0.5) — detects timezone changes
2. Checks `task-tz-state.json` for missed tasks (Step 0.6) — may invoke `morning-brief` or `nightly-housekeeping`
3. Calls `check-unanswered` (Step 4) — scans for unreplied messages
4. Calls `check-system-health` (Step 5) — DB health, stuck tasks

## Morning Brief (runs daily, 8am local)
1. Reads Google Calendar via Composio (Step 1)
2. Reads Google Tasks via Composio (Step 2)
3. Runs `morning-brief-fetch.py` script (Step 3) — reads `morning-brief-pending.json`
4. Runs `morning-brief-cfp.py` script (Step 4a) — reads CFP state
5. Calls `check-calendar` internally (Step 8) — sets up reminders
6. Updates `task-tz-state.json` with `last_run_date` (Step 9)

## Nightly Housekeeping (runs daily, 11pm local)
1. Calls `check-travel-bookings` (Step 3)
2. Calls `check-orders` (Step 5)
3. Writes `morning-brief-pending.json` (Step 6) — consumed by next morning-brief
4. Archives daily logs → weekly (Step 7-8)
5. Calls `check-watchlist` (Step 9)
6. Updates `task-tz-state.json` with `last_run_date` (Step 10)
7. Runs backup script + `github_backup` MCP (Step 10b)

## Shared State Files
| File | Written by | Read by |
|------|-----------|---------|
| `task-tz-state.json` | task-tz-sync, morning-brief, nightly-housekeeping | heartbeat (missed task detection) |
| `morning-brief-pending.json` | nightly-housekeeping (Step 6) | morning-brief (Step 3) |
| `session-state.json` | any skill (pending response tracking) | heartbeat (pending response check) |
| `calendar-state.json` | check-calendar | check-calendar (diff against previous) |
| `cfp-state.json` | check-cfps | check-cfps, morning-brief-cfp.py |
