# Proposal — Self-Resuming Scheduled Processes

**Status:** proposal · **Tracked in:** [#93](https://github.com/jbaruch/nanoclaw/issues/93) · **Date:** 2026-04-21

## Problem

Today's nightly-housekeeping run deferred a large tail of steps via its compaction-aware budget gate:

> Skipped (compaction-aware budget, will pick up next nightly):
> • check-orders (5), check-cfps (6), undated-tasks (7)
> • dedup-memory (9), archive-daily (10), daily_discoveries (11), memory-hygiene (12)

The deferral was originally added to prevent the nightly container from crashing the run loop on context exhaustion. It does prevent the crash — but the same steps get deferred every night in the same order, so the tail **never executes**. "Skipped, will pick up next nightly" is equivalent to "never runs" when the cycle is deterministic.

Same pattern applies to `weekly-housekeeping` and `morning-brief` — any skill that budgets its own work and skips-forward on low budget has the same problem.

## Proposal

Replace "defer to next cycle" with "continue in a fresh container, right after". Fresh container = fresh context budget. The chain completes one full cycle of steps regardless of how many continuations it takes.

### Shared mechanism (single implementation, three callers)

Build this once as a reusable pattern — most likely a small skill `tessl__resumable-cycle` — and wire all three skills (`nightly-housekeeping`, `weekly-housekeeping`, `morning-brief`) to it. The helper doesn't care which skill is continuing; it cares about `{skill_name, cycle_id, remaining_steps}`.

### Flow

1. **Pre-step budget check.** Before each step, the skill decides "can I complete this and still have headroom for one more?" Same gate as today.
2. **On budget-low, instead of skipping-with-note:**
   - Write to the consolidated `/workspace/group/nanoclaw-state.json` (per `maintenance/maintenance-2026-03-27.md` §10 — state files are being consolidated into one versioned file, not fragmented into a new per-skill file), storing resume data under a per-skill key:
     ```jsonc
     {
       "version": 1,
       "resumable_cycles": {
         "tessl__nightly-housekeeping": {
           "cycle_id": "<slot key for this cycle — see §slot keys below>",
           "remaining_steps": ["check-orders", "check-cfps", "undated-tasks",
                               "dedup-memory", "archive-daily",
                               "daily_discoveries", "memory-hygiene"],
           "continuation_count": 1,
           "created_at": "<ISO-8601 UTC>"
         }
         // other skills' entries live alongside under their own keys
       }
       // plus whatever other top-level state nanoclaw-state.json holds
     }
     ```
     **Schema invariant:** `remaining_steps` is the single source of truth for what's left. Prior drafts carried both `resume_from_step` and `remaining_steps`; they drift. If a caller needs the positional index for logging, derive it at read time as `len(original_step_list) - len(remaining_steps)` — do not persist it.

     **Concurrency + write-ordering guarantee.** `nanoclaw-state.json` is touched by more than one actor once resumable cycles land (the original run, continuations in the maintenance session, any user-invoked skill that reads or writes unrelated keys), so atomic rename alone is not enough — it prevents partial reads, not lost read-modify-write updates. Every mutation for resumable-cycle state MUST take an exclusive `fcntl.LOCK_EX` on a new sidecar lock file `/workspace/group/nanoclaw-state.lock` around the whole RMW: acquire lock → read the current JSON → mutate only `resumable_cycles.<skill_name>` (preserving unrelated keys and other skills' entries) → temp file + `fsync` + rename → read-back verify while still holding the lock → release lock. Any later mutation during the chain (shrinking `remaining_steps`, replacing the entry on the next continuation, clearing it on completion) reacquires the same lock and re-reads — never mutates based on an in-memory snapshot from an earlier step. The `schedule_task` call happens AFTER the lock-protected write has committed and verified. Strict order: lock + atomic RMW → read-back verify → unlock → schedule_task → exit.

     This expands `nanoclaw-state.json`'s current §8 registry entry from "single writer, atomic write" to "multi-writer, `fcntl.LOCK_EX` on `nanoclaw-state.lock`" — a §8 registry row update in `docs/tile-plugin-audit.md` lands alongside Phase 1 implementation.
   - Call `mcp__nanoclaw__schedule_task(schedule_type: "once", schedule_value: <ISO-8601 UTC timestamp for now+30s, e.g. new Date(Date.now() + 30_000).toISOString()>, context_mode: "isolated", prompt: "Continue <skill_name> from resumable_cycles.<skill_name> in /workspace/group/nanoclaw-state.json and execute remaining_steps.")`. `schedule_value` for `schedule_type: "once"` is parsed by `new Date(...)` in `src/ipc.ts` — it must be a real timestamp string, not a placeholder.
   - Log `continuation N scheduled — steps X..Y will run in ~30s` and exit cleanly. DO NOT mark the cycle complete; only the final (non-continuing) run marks complete.
3. **Entry point of each affected skill** reads `resumable_cycles.<skill_name>` from `/workspace/group/nanoclaw-state.json` (under the state lock, so it never observes a partial RMW) and inspects its invocation signal (see §Continuation marker below):
   - **Invoked as a continuation** AND `cycle_id` in the entry matches the current slot key → this is a legitimate chain link; run `remaining_steps` in order and skip Phase A/B/C lock acquisition (the cycle is already logically in-progress via the matching resumable-cycle state + continuation signal; see §Safety → Lock lifecycle). A user-invoked manual run that finds the same state entry but has NO continuation signal does NOT take this branch — that's the whole point of the marker; otherwise a user kicking a housekeeping skill mid-chain would skip Phase A and collide with the continuation.
   - **Invoked fresh** (no continuation signal), regardless of whether a stale `resumable_cycles.<skill_name>` is present: run the normal Phase A/B/C sequence. If Phase A sees the cycle's `pending_run_at` still set (current lock-protocol behavior), the fresh run stops as designed — the state entry alone never overrides the lock. If `cycle_id` in the state entry doesn't match the current slot, Phase C clears the stale entry as part of its normal state-file update (under the same state lock).
   - **Absent AND fresh invocation** → normal start, no special handling.
4. **Final step of the skill** reacquires the state lock, reloads the latest `nanoclaw-state.json`, and in one locked transaction: (a) clears `resumable_cycles.<skill_name>` *only if* its stored `cycle_id` still matches the cycle being completed (a stale finisher must not erase a newer continuation's entry), (b) writes the existing `last_run_date` / `nightly_last_completed` completion markers, (c) read-back verifies, (d) releases the lock.

### Slot keys

`cycle_id` is the slot key for the cycle currently in progress. Per-skill rule:

| Skill | Slot key | Example |
|---|---|---|
| `tessl__nightly-housekeeping` | UTC date of the kickoff | `2026-04-21` |
| `tessl__weekly-housekeeping` | ISO week of the kickoff | `2026-W17` |
| `tessl__morning-brief` | UTC date of the brief's target morning | `2026-04-21` |

A continuation inherits the ORIGINAL run's slot key — the value is written by the original run and never recomputed during the chain. Fresh runs (no resume-state present, OR stale resume-state present) compute the slot key from the current UTC clock.

### Continuation marker

A continuation must be distinguishable from a user-invoked run. Two signals combine, and both must agree — disagreement fails closed to "fresh invocation":

1. **Prompt prefix.** `schedule-continuation` (the helper entry point introduced in §Shape of the change) writes the scheduled-task prompt as `"[CONTINUATION <cycle_id> #<continuation_count>] Continue <skill_name> from resumable_cycles..."`. The skill's entry point parses this prefix; its presence is the primary "invoked as continuation" signal. Prefix presence alone is never trusted — continuation path also requires the scheduler-set env signal below.
2. **Env var.** The scheduler sets `NANOCLAW_CONTINUATION=1` (+ `NANOCLAW_CONTINUATION_CYCLE_ID=<cycle_id>`) on the spawned continuation container. The skill cross-verifies this against the prompt prefix; if either is missing, or the cycle_id values diverge, the entry point runs as fresh and logs a `CONTINUATION-SIGNAL-MISMATCH` diagnostic for Baruch.

Belt-and-suspenders on purpose: a scheduler bug that sets the env but mangles the prompt (or vice versa) would otherwise let a half-signaled run silently take the lock-skip branch.

### Safety

- **Cap continuations.** `continuation_count <= 4` per cycle. On cap hit, log loudly (`HOUSEKEEPING-CAP-HIT: <skill> <cycle_id> stopped at step <n>`), fall back to today's defer-to-next-cycle behavior, and surface to Baruch. Prevents infinite chain on a genuinely-broken step.
- **Lock lifecycle.** The two-phase lock protocol is documented in the admin tile's `rules/follow-me-two-phase-lock.md` (lives in the `jbaruch/nanoclaw-admin` tile repo, external to this repo; Phase A/B/C/confirm semantics are defined there). Under that protocol, the ORIGINAL run acquires on Phase C and confirms on Step 14. Continuation runs must NOT re-acquire (Phase A would see `pending_run_at` and stop immediately — which is correct for a concurrent user-invoked run, wrong for a continuation). Fix: only continuation-signaled runs for the matching `resumable_cycles.<skill_name>` entry SKIP Phase A/B/C, and only the FINAL continuation performs Step 14's confirm write. State presence alone is not sufficient to skip lock phases.
- **Parallel-session isolation.** Inbound user messages mid-chain still route to `default` session per existing parallel-maintenance design. Each continuation runs in `maintenance` session; isolation is per-session, not per-container-lifetime, so this should Just Work — but worth a test.

### Shape of the change

- **New reusable skill `tessl__resumable-cycle`** with two documented entry points:
  - `Skill(skill: "tessl__resumable-cycle", args: "check")` — at the start of each calling skill, reads `resumable_cycles.<skill_name>` from `nanoclaw-state.json`, validates the slot key matches the current slot, and returns `{cycle_id, remaining_steps}` or `"none"`.
  - `Skill(skill: "tessl__resumable-cycle", args: "schedule-continuation", …)` — at the budget-low branch, writes the `resumable_cycles.<skill_name>` entry and schedules the one-shot with an ISO-8601 timestamp.
- **Three skill updates** — `nightly-housekeeping`, `weekly-housekeeping`, `morning-brief` each:
  - Replace the defer-with-skip block with a call to `schedule-continuation`.
  - Add the resume-state check at the entry point.
  - Update the lock protocol per §lock handling above.
- **One orchestrator consideration** — baseline continuation latency is the scheduled-task poll interval, currently `SCHEDULER_POLL_INTERVAL = 60_000` in `src/config.ts` (a fixed 60s). Actual continuation start can be later due to per-group maintenance queueing. Acceptable for nightly/weekly; `morning-brief` is tighter because it targets a specific local time, but the continuation would still fire within the brief window regardless.

### Tradeoffs

- **Pro:** deferred tail actually runs on the same calendar day.
- **Pro:** self-contained in skills + helper. No orchestrator change required beyond what `schedule_task` already does.
- **Con:** cycle becomes a chain of short containers, not one long run. "Nightly completed at …" becomes "nightly chain completed at …"; operationally slightly harder to reason about timing.
- **Con:** more container spawns per cycle = more credit, more chance of transient failure on any link. The cap mitigates worst case.
- **Con:** lock protocol nuance — continuation skipping Phase A/B/C has to be bulletproof. A bug there re-introduces the silent-skip class that two-phase was built to prevent.

## Open questions

1. **Helper as rule or as skill?** A rule is lower-cost (no new skill to promote/review/invoke) but `schedule_task` is concrete behavior, not a rule. Leaning toward a small `tessl__resumable-cycle` skill with two `Skill()` entry points.
2. **Do we need a separate "continuation" wake reason or re-use the scheduled-task fire?** Scheduled-task fires the skill directly, so nothing new needed.
3. **morning-brief timing constraint.** A brief that chains past its target local time (e.g. starts at 06:00, still running at 06:30) might produce a confusing UX. Consider: either shorten the brief's work on a continuation (skip the less-urgent tail), or accept that it completes when it completes.

## Review focus

Looking for a review pass on this design — **lock-handling correctness especially**. Once aligned, implement the `tessl__resumable-cycle` helper and roll into nightly / weekly / morning-brief. Open to one PR across all three vs three small PRs — reviewer's preference.
