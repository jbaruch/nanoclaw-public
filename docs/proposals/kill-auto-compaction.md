# Kill auto-compaction: threshold-nuke + checkpoint/reentry skills

Replace auto-compaction with a single state-handling code path —
threshold-triggered nuke bracketed by an orchestrator-built `## Facts`
section (deterministic) plus an optional agent-authored `## Reasoning`
section (best-effort) before the nuke, and a `session-reentry` skill
that consumes whatever's there afterwards. Eliminates the parallel
rule universe that compaction-resume creates and structurally prevents
the "stale skill block re-executed as a new task" class of incident.

## Problem

Auto-compaction creates a parallel rule universe. At compaction time
the conversation is summarized, but tool history (system-reminders,
including skill-invocation blocks) gets re-injected as if it were a
fresh request. Three observed failure modes:

- **Stale skill blocks treated as new tasks.** On 2026-04-24 the
  `agent-browser` JCON-2026 speakers scrape was re-executed ~4 hours
  after the user confirmed completion. A memory rule
  (`feedback_system_reminder_skill_history.md`) was added the same
  day. On 2026-04-25 the same skill block triggered the same wrong
  execution despite the memory rule existing — the agent reads
  `MEMORY.md` index lines, not memory file bodies, so the warning
  never fires at the relevant moment.

- **Loss of mid-task reasoning.** Compaction summary captures "what
  happened" but not "why I was about to do X next". The agent often
  re-derives a worse plan after compaction.

- **Memory drift.** Memory entries written in the to-be-compacted
  window may not survive into the next session faithfully.

Underlying these: **two state-handling code paths in parallel**
(compaction-summarize vs. nuke-and-resume). Twice the failure
surface, twice the rules the agent has to know.

## Scope

This proposal applies to **the `default` session slot of every
group**. Maintenance slots are isolated by default (#114, PR #118),
so they self-resolve and don't need a threshold-trigger path. The
trigger logic, checkpoint write, and reentry skill all run only in
the user-facing `default` flow.

## Components

### 1. Layered checkpoint — orchestrator-built `## Facts`, agent best-effort `## Reasoning`

The checkpoint file has **two sections written by two writers**.
Neither alone is reliable in the worst case; together they cover
each other.

| Section | Writer | Content | Failure mode |
|---|---|---|---|
| `## Facts` (objective) | **Orchestrator** (always) | invoked-skills + state-mutating-tool-calls list with arguments and completion timestamps; pending message IDs awaiting reply; sessionId; cursor (last user message timestamp); registered-group config snapshot; in-flight scheduled tasks for this group | None — the orchestrator owns this state already (DB rows, JSONL transcript, in-memory registry). Writes deterministically. |
| `## Reasoning` (subjective) | **Agent** (best-effort) | active task & sub-task; "why I was about to do X next"; open file edits in flight (path + intent); recent decisions and their rationale (last 5–10) | Missing or low-quality if agent ignores the threshold reminder. Reentry tolerates an empty section. |

**Rationale.** The agent at threshold-time is in exactly the same
context-pressure state that triggered the nuke — the writer paradox.
If only the agent writes the checkpoint, reliability degrades when
we need it most. The orchestrator, conversely, has none of the
context-pressure problem; it can write `## Facts` deterministically
from observable state. The agent layer adds reasoning narrative
when it can; when it can't, we still have the load-bearing facts.

### 2. Source for `## Facts` — built fresh at threshold-time, not periodic

`## Facts` is materialized at threshold-time from:

- **JSONL transcript** at `data/sessions/<group>/default/.claude/projects/<slug>/<sessionId>.jsonl`.
  Parsed for `tool_use` blocks; matched against corresponding
  `tool_result` blocks to compute completion timestamps. PR #111
  already walks this path for nuke; we already depend on the format.
- **DB / in-memory state.** Pending replies, sessionId, cursor,
  registered-group snapshot, in-flight task list — all already
  available in the orchestrator without new instrumentation.

**Why not a periodic event log.** A separate `events/<sessionId>.jsonl`
appended on every IPC consumption would reduce threshold-time work
but trade always-on overhead for a rare-event optimization. The JSONL
is already authoritative; a parallel event log creates a sync problem
we don't currently have.

**Crash-recovery side benefit.** If the orchestrator dies before
threshold, the JSONL is still on disk. Reentry on the next spawn
can read it directly and reconstruct enough state to continue. The
checkpoint file is a *materialized view*, not the only truth.

### 3. "Do NOT re-execute" list — state-mutating tools only

The Facts section captures every tool call that **mutates state**.
Reads (Grep, Glob, Read, read-only Bash patterns) get no entry —
the agent re-reading post-reentry is fine and even desirable.

**Mutating-tool taxonomy** (each tool definition declares
`mutates: true|false`; the JSONL parser uses the flag to filter):

- **Always mutating**: `Skill`, `send_message`, `react_to_message`,
  `send_file`, `pin_message`, `schedule_task`, `update_task`,
  `register_group`, `set_trusted`, `set_trigger`, `Write`, `Edit`,
  `MultiEdit`, all Composio side-effecting tools (their handlers
  declare it).
- **Always read**: `Read`, `Grep`, `Glob`, `pull_request_read`, the
  read-only `mcp__github__*` family, etc.
- **Bash**: argv-prefix allowlist for read-only commands. Everything
  else is treated as mutating (false positives are noise; false
  negatives are the JCON failure mode).

**Bash read-only allowlist (v1):**

```
cat ls grep find head tail wc sort uniq pwd echo
git status, git log, git diff, git show
file stat date
```

Anything starting with `bash: <other>` lands in `## Facts` as a
mutating call. List is extensible per pattern observed in production.

### 4. Threshold-trigger handshake

```
1. Orchestrator detects threshold cross (see formula below).
2. Orchestrator writes `## Facts` to .checkpoints/default.md
   deterministically. (rotates the prior default.md to previous.md
   first — see Files below.)
3. Orchestrator injects a system-reminder into the agent's context:
   "MANDATORY FIRST ACTION: append your `## Reasoning` section to
   .checkpoints/default.md, then write `_close` to IPC. Threshold
   reached; session will be nuked after this turn."
4. Orchestrator starts a 30-second grace timer.
5. End-of-turn (`_close` seen OR grace expires):
     - call `nuke_session` (PR #111) for the default slot
     - next inbound message spawns a fresh container
     - first action in the new session: `session-reentry` skill
       reads .checkpoints/default.md
```

**Why a grace timer.** Worst case: agent is mid-tool-call when
threshold trips and never reaches the system-reminder. Without a
timer we'd never nuke. With a 30s timer the worst-case behaviour
is "Facts-only checkpoint, no Reasoning" — the documented degraded
mode, not a deadlock.

### 5. Threshold formula

```
threshold_warn = min(70% of context, context - 200K)
threshold_nuke = min(80% of context, context - 100K)
```

The percentage handles large-context models cleanly (Opus 4.7 1M:
warn at 700K, nuke at 800K). The headroom floor handles
smaller-context models where 70/80% would leave too little room
to write the checkpoint and reentry context.

**At `threshold_warn`**: the orchestrator surfaces an in-line note
to the user ("approaching context limit; will reset after the next
turn"). Reduces the surprise of the seam.

**At `threshold_nuke`**: the handshake above fires.

**Per-group override**: deferred. We have zero data on whether any
group needs a different value. If a future group hits the seam too
often, add a `compaction_threshold_pct INTEGER` column to
`registered_groups` and override there.

### 6. Files

```
/workspace/group/.checkpoints/
  default.md   — live checkpoint (latest)
  previous.md  — one rotation deep, forensics only
```

**Rotation.** On each threshold-trigger, the orchestrator does
`mv default.md previous.md` (overwriting any existing previous.md)
*before* writing the new `## Facts`. Single file replaced atomically;
no lock dance.

**Container-visible writable mount.** The checkpoint files live
under `/workspace/group/`, the same per-group writable mount the
agent already uses. Reentry reads `default.md` via the agent's
normal Read tool. The orchestrator writes via direct fs.write on
the host-side path.

**`previous.md` is forensics-only.** Reentry never reads it. Falling
back to it on a corrupt `default.md` would mean loading state from
*two sessions ago* — its "do NOT re-execute" list misses every
mutating call from the just-nuked session, masquerading as fresh.
That's structurally worse than no list. Operators who want to
investigate a weird reentry can `cat previous.md` from a shell.

### 7. `session-reentry` skill — first action on every default-slot spawn

Reentry reads `default.md` and treats it as **durable conversation
context**, not a system-reminder tail. Whatever's there gets loaded;
whatever's missing is silently absent.

**Failure-mode handling:**

| Case | Trigger | Behaviour |
|---|---|---|
| Missing | First-ever spawn, or operator manually deleted default.md | Silent no-op. Normal session start. |
| Corrupt | File exists but no parseable `## Facts` section | Treat as missing. Log a single WARN to `groups/<group>/logs/`. |
| Partial | `## Facts` present, `## Reasoning` empty | Use what's there. Expected degraded mode, not a failure. |
| Mid-reentry crash | Skill itself errors (read fails, parser bug) | Silent fallthrough to normal session. |

The structural rule: *staleness must never be confusable with freshness*.
Better to start clean than to load stale state pretending to be fresh.

### 8. `context-recovery.md` rewrite

Drop the current resume-time guidance. Replace with: *if
`/workspace/group/.checkpoints/default.md` exists, run
`session-reentry`. Otherwise, ask before acting — never re-execute
skill blocks from system-reminder tails.*

## Roll-out

Five non-overlapping phases, each shippable and observable before
the next starts.

| Phase | Scope | Acceptance gate |
|---|---|---|
| 1. Instrument + verify disable knob | Token-usage metric per session. Set `DISABLE_COMPACT=1` in container env at spawn. Run a synthetic session crossing 90% and confirm zero compaction events fire (verified via JSONL inspection). | Telemetry visible in logs; `DISABLE_COMPACT=1` produces no compaction event in the headless `claude --print --no-chrome` invocation. |
| 2. `## Facts` writer + checkpoint file | Orchestrator writes the `## Facts` section to `default.md` at threshold-trigger. No nuke yet — auto-compaction is still on. Validates the file format and the JSONL parser. | After 1 week of real default-slot traffic, the format is stable and the parser doesn't trip on real transcripts. |
| 3. `session-reentry` skill | Ship the skill. Manually test: nuke a session, spawn a fresh one, verify reentry consumes `default.md` cleanly. | Manual exercise on at least one group; the agent's first-turn behaviour after manual-nuke + fresh-spawn matches expectation. |
| 4. Flip default | Set `DISABLE_COMPACT=1` permanently. Wire `## Reasoning` system-reminder injection + grace timer. Threshold trigger calls the full handshake → `nuke_session` → next turn runs `session-reentry`. Rewrite `context-recovery.md`. | Phase 2-3 telemetry green; UX-visible seam ratchet'd. |
| 5. Observe | First two weeks: surface every reentry event to an admin telemetry channel so failure modes are visible. | Failure modes catalogued; per-group threshold override considered if any group is firing too often. |

## Pros

- **One code path.** Compaction logic and nuke logic become the same
  flow.
- **Source of truth lives in DB + memory + JSONL + checkpoint file**,
  not in a model-summarized synopsis.
- **Trivial per-turn rules** — the agent doesn't need to distinguish
  "is this skill block historical?" because there are no skill blocks
  injected post-nuke.
- **JCON repeat-execute pattern becomes structurally impossible.**
- **No total-loss failure mode.** Worst case is `## Facts` only, no
  `## Reasoning` — the load-bearing half is always present.
- **Memory state and durable files reflect reality at nuke-time**,
  not at compaction-summary fidelity.

## Cons & mitigations

- **Mid-task reasoning loss is more visible.** Compaction fakes
  continuity; nuke makes the seam real.
  *Mitigation:* `## Reasoning` captures it when the agent is
  compliant; the warn threshold gives the user advance notice.

- **UX seam: forced reset turn at threshold.** If the user is
  mid-conversation when threshold hits, there's a visible reset.
  *Mitigation:* `threshold_warn` (70%) pre-warns the user in-line;
  nuke fires only at end-of-turn, never mid-tool-call.

- **Token cost overhead.** `## Reasoning` write + reentry load add
  tokens each cycle.
  *Mitigation:* threshold-only firing, no periodic checkpoints.

- **Long tasks across multiple cycles.** Complex multi-cycle tasks
  need explicit task-pinning.
  *Mitigation:* `## Reasoning` includes an explicit "continuation
  thread" pointer; the agent can use it on reentry to resume.

## Open questions

These remain genuinely undecided and worth tracking through Phase
2-3 telemetry before committing.

1. **System-reminder phrasing.** What exact wording reliably gets
   the agent to comply with the `## Reasoning` write? Phase 2 ships
   without the reminder (Facts only); Phase 4 introduces it. The
   first cut should mirror the heartbeat prompt's "MANDATORY FIRST
   ACTION" pattern, but the actual phrasing may need tuning based
   on observed compliance rates.

2. **Mutating-tool list completeness.** v1 enumerates the obvious
   mutators. New MCP tools added after this proposal lands need to
   declare their `mutates` flag. There should be a CI check that
   refuses to land an MCP tool definition without the flag set,
   but that's a follow-up issue.

3. **`session-reentry` content shape.** Does the skill load
   `default.md` verbatim into the conversation, or paraphrase it?
   Verbatim is simpler but bigger; paraphrased is smaller but adds
   an LLM step before the user's first reply lands. Phase 3 should
   try verbatim first.

4. **Future: explicit fresh-start mechanism.** A future enhancement
   to `nuke_session` could accept `{ skipReentry: true }` for the
   case where the operator wants a deliberate fresh session without
   manual file deletion. Not part of MVP.

## Reference incidents

- **2026-04-24:** JCON-2026 speakers scrape re-executed ~4 hours after
  completion. Memory rule `feedback_system_reminder_skill_history.md`
  added.
- **2026-04-25:** Same skill block, same wrong execution. Memory rule
  was insufficient — the agent reads `MEMORY.md` index lines, not the
  file body, so the warning never fires at compaction-resume time.

## Dependencies

- **#100 / PR #111** — merged. `nuke_session` wipes the JSONL on
  disk; the threshold-nuke path is no longer cosmetic.
- **#114 / PR #118** — merged. Heartbeats default to
  `context_mode: 'isolated'`, so the threshold-trigger doesn't need
  to handle the maintenance-session bloat case (it self-resolves).
- **`DISABLE_COMPACT=1`** env var — confirmed in the Claude Code
  CLI changelog. Phase 1's acceptance gate verifies it actually
  takes effect under the headless `claude --print --no-chrome
  --strict-mcp-config` invocation NanoClaw uses.

## Tracking

Tracks issue #104.
