# Server-Error Feedback Loop

Feed orchestrator errors to the agent via a shared buffer, triaged every heartbeat cycle, so the system notices its own pathologies instead of logging them to a file nobody reads.

## Problem

Server-side errors in the orchestrator — grammy send failures, IPC parse errors, task-scheduler exceptions, Docker spawn failures, SQLite lock timeouts, polling retries — land in `logs/nanoclaw.log` and nowhere else. The agent doesn't see them. Baruch doesn't see them unless he greps the log. Recurring failures stay silent until a human notices a symptom.

The #81 ghost investigation is the canonical example: the task-scheduler `storeMessage` gap (bug 1) AND the sanitizer stray-tag crash (bug 2) were both visible in `docker logs` during the week they were silently dropping sends. Nine rounds of forensics would have been three if the agent had been surfacing "this class of error fired 12 times today — new pattern?" to Baruch within hours.

## Proposal

Add a JSONL error buffer the orchestrator appends to on every caught error. Add an admin-tile `triage-errors` skill that heartbeat invokes each cycle. The skill classifies entries against a pattern library, acts per tier, and advances a cursor so work isn't repeated.

### Scope phasing

Three non-overlapping phases — ship and observe each before starting the next.

| Phase | Scope | Risk |
|---|---|---|
| 1. Producer | Host-side buffer + `recordError()` helper; wire into known error sites. No consumer yet. | None — buffer sits on disk, not read by anyone. |
| 2. Tier 0 triage | Admin skill reads buffer each heartbeat, classifies against a pattern library, writes findings to `daily_discoveries`. No user-facing output. | None — log-only. Earns the pattern library. |
| 3. Tier 1 alert | Same skill also surfaces unknown patterns and critical matches to Baruch via `send_message`. | Noise risk if the pattern library is too loose. Tier 0's data defines the library before Tier 1 ships. |

Tier 2 (autoremediation from an allowlist) is **out of scope for this proposal** — worth its own discussion after Tier 1 earns a month of observations.

## Data shape

`/workspace/group/server-errors.jsonl` — append-only JSONL, one object per line:

```jsonc
{
  "id": "err-1776754907142-a1b2",       // unix-ms + 4 hex chars; unique identifier
  "ts_ms": 1776754907142,                // unix-ms as integer — canonical ordering field, used for cursor compare
  "ts": "2026-04-21T10:15:32Z",         // UTC ISO-8601, derived from ts_ms (for humans)
  "source": "telegram-send",             // producer tag — see table below
  "level": "warn",                       // severity; allowed values: "warn" | "error"
  "stable_key": "grammy-400-msg-not-found",  // human-readable normalised key. Pattern library matches on this.
  "fingerprint": "a1b2c3d4e5f60718",     // sha1[:16] of (source + "|" + stable_key). In-memory dedup key only.
  "message": "short human summary",      // 1 line, ≤200 chars, redacted
  "context": {                           // arbitrary structured data, redacted
    "chat_jid": "tg:-1003...",
    "telegram_code": 400,
    "stack_tail": "..."
  }
}
```

Three fields collectively carry identity / ordering / classification — each has a single purpose and they don't overlap:

- **`ts_ms` — integer, canonical sequencing.** The consumer cursor compares integers (`entry.ts_ms > cursor_ts_ms`), not strings. Avoids lexicographic-compare ambiguity (a prefix-change or width-shift in `id` could break comparisons silently). The producer generates `ts_ms = Date.now()` and derives `id` and `ts` from it.
- **`stable_key` — human-readable classification.** The message with timestamps, PIDs, random IDs, and hex blobs stripped so `"GrammyError 400: message 5169 not found"` and `"GrammyError 400: message 5174 not found"` both become `"grammy-400-msg-not-found"`. **The pattern library (`/workspace/trusted/error-classifications.md`) matches on `source + "|" + stable_key`** — NOT on `stable_key` alone, since the same normalised message text could legitimately mean different things under different `source` values (e.g., `"connection refused"` from `db` vs `polling`).
- **`fingerprint` — 16-hex in-memory dedup.** `sha1(source + "|" + stable_key)[:16]` = 64 bits. Used only by the producer's `recent_fingerprints` deque (60s window, N=20) for fast dedup comparisons within a single Node process. NOT used for cursor sequencing, NOT the library match key, NOT compared across processes or runs. 8 hex (32 bits) would hit birthday collisions near ~65k distinct errors; 16 hex lifts that to ~4 billion, comfortably out of any realistic register.

### Producer `source` vocabulary

Fixed at ship time. Adding a new `source` value requires a code change (intentional — forces producer sites to be enumerated).

| Source | Emitted by | Example |
|---|---|---|
| `telegram-send` | `src/channels/telegram.ts` | HTML-parse-failed fallback fire, pool-bot 409, sendFile caption parse error |
| `ipc-parse` | `src/ipc.ts` | Malformed JSON from agent IPC file |
| `ipc-handler` | `src/ipc.ts` | Handler exception (send_message, schedule_task, etc.) |
| `task-scheduler` | `src/task-scheduler.ts` | Script launch failure, non-zero exit, timeout |
| `container-runner` | `src/container-runner.ts` | Docker spawn failure, OOM kill, image missing |
| `db` | `src/db.ts` | SQLite lock timeout, schema mismatch, integrity error |
| `polling` | `src/channels/telegram.ts` | Long-poll restart, conflict with another poller |
| `orchestrator` | `src/index.ts` | Unhandled exception escaping a handler |
| `error-triage` | Reserved | Triage skill's own execution context. Producer drops these silently (triage-of-triage guard, see §Triage-of-triage filter). Never written to the buffer. |

## Buffer lifecycle

- **Append-only writes.** One line per `recordError()` call (modulo dedup — see §Dedup / rate limiting).
- **Producer-side cap.** On every write, if the file exceeds 1000 lines OR 2 MB, drop the oldest entries to bring it back under cap. Held-inside-the-same-LOCK_EX as the write itself so there's no concurrency leak. The cap pass is a serialized read+truncate inside the exclusive lock; the only failure mode is a mid-operation crash (producer dies after writing N but before truncating M) which leaves the file over cap temporarily — the next write's cap pass corrects it.
- **Consumer-side cursor.** The triage skill writes `errors_triage_cursor_ts_ms = <last ts_ms processed>` to `/workspace/group/heartbeat-state.json`. On read, it processes entries with `entry.ts_ms > cursor` — integer comparison, unambiguous. If the cursor is older than the oldest `ts_ms` in the current file (producer cap trimmed it away), the consumer bootstraps from the oldest available line and logs a gap entry to `daily_discoveries`.
- **Locking — producer.** Producer takes `fcntl.LOCK_EX` on `/workspace/group/server-errors.jsonl.lock` for the write+cap pass. Node doesn't expose `fcntl` natively, and **the implementation must use the same OS-level advisory-lock primitive the Python consumer uses** — otherwise the two sides don't see each other's locks and can both believe they hold the lock (a bug `proper-lockfile` would introduce, since it's a rename-based lockfile protocol, not OS advisory locks). Phase 1 spawns `flock(1)` via `child_process.spawn` around each producer write; `flock(1)` uses the same underlying `fcntl.flock` syscall as Python. Linux-only, which matches the deployment target. Small per-write overhead (~1ms child-process spawn) is acceptable since producer writes are already rare (deduped, capped).
- **Locking — consumer (snapshot-then-release, not held-across-send).** The triage skill acquires LOCK_EX only long enough to (a) read the buffer from disk, (b) snapshot the unread tail, (c) advance the cursor in memory, then releases the lock. Classification, `send_message` calls, and the heartbeat-state.json cursor write all happen AFTER the lock is released. This matters because Tier 1 `send_message` is a network call; holding the buffer lock across it would block producers in the orchestrator's hot path at exactly the moment the system is unhealthy (cascading-stall risk). A second LOCK_EX pass at the end of triage writes the new cursor value.
- **Reference implementation to copy.** `session-state.json` today uses the same lock-file pattern — see `heartbeat-precheck.py` in the admin tile: [jbaruch/nanoclaw-admin → `skills/heartbeat/scripts/heartbeat-precheck.py`](https://github.com/jbaruch/nanoclaw-admin/blob/main/skills/heartbeat/scripts/heartbeat-precheck.py) (search for `fcntl.flock` + `session-state.json.lock`). The convention is documented in [`docs/tile-plugin-audit.md` §8, landing in sibling PR jbaruch/nanoclaw#98](https://github.com/jbaruch/nanoclaw/pull/98) — merges before this proposal's Phase 1 ships.

## Dedup / rate limiting

Producer-side fingerprint:

```
fingerprint = sha1(source + "|" + stable_key)[:16]
```

`stable_key` is defined in §Data shape — the error message normalised for classification (timestamps, PIDs, random IDs, hex blobs stripped). 16 hex = 64 bits, comfortably above the ~65k birthday-collision threshold of a 32-bit prefix.

Producer keeps an in-memory `recent_fingerprints: deque[(fp, ts)]` of the last N=20. Before writing, if the same fingerprint appears in the deque within M=60 seconds, **drop the event entirely** — don't write, don't bump counters. Prevents a 429-storm or a broken-handler loop from flooding the buffer.

This deliberately accepts loss: a burst of 100 identical errors in 60s becomes 1 written entry. The triage consumer can still detect "this fingerprint fired again" via its own classification pass across cycles, and the pattern library can note "expect bursts" on known-burst fingerprints (e.g. rate limits). Avoiding a "bump counter on the prior line" scheme keeps the JSONL shape single-event-per-line — simpler writer, simpler reader.

**Library keying.** The pattern library (`/workspace/trusted/error-classifications.md`) matches entries by `source + "|" + stable_key` (e.g. `telegram-send | grammy-429-ratelimit`), NOT by `fingerprint`. The fingerprint is a derived in-memory key for the producer's dedup deque only — it plays no role in classification or sequencing. Sequencing is on `ts_ms` (§Data shape); the library match key is the human-readable `source + "|" + stable_key` tuple.

## Triage skill shape

`skills/triage-errors/SKILL.md` in `nanoclaw-admin`, invoked by heartbeat:

Two-phase locking — snapshot briefly, then act outside the lock. Never holds the buffer lock across a `send_message` network call (which could cascade into producer stalls).

**Phase A: snapshot under LOCK_EX** (milliseconds):

1. Acquire `fcntl.LOCK_EX` on `/workspace/group/server-errors.jsonl.lock`.
2. Read `/workspace/group/server-errors.jsonl` into memory.
3. Read `errors_triage_cursor_ts_ms` from `heartbeat-state.json`.
4. Compute `unread_snapshot = [entry for entry in buffer if entry.ts_ms > cursor]` and `new_cursor_ts_ms = max(entry.ts_ms for entry in unread_snapshot)` (or unchanged if unread_snapshot is empty).
5. Release the buffer lock.

**Phase B: classify + alert without the lock** (may include slow `send_message` network calls, pattern-library reads, stderr annotations):

6. Read `/workspace/trusted/error-classifications.md` — the pattern library (human-maintained + agent-proposed; single flat file).
7. For each entry in `unread_snapshot`:
   - Classify against the library on `source + "|" + stable_key`: `{transient, known-critical, unknown}`.
   - **Tier 0 (Phase 2)** — append a one-line note to `/workspace/trusted/memory/daily_discoveries.md` (per the existing trusted-memory convention — single file, not per-day) with classification + stable_key + one-line cause. Dedup by stable_key per day inside the file (the append-or-bump logic is the same as any existing daily_discoveries writer).
   - **Tier 1 (Phase 3)** — additionally, if `known-critical` OR `unknown`, surface via `mcp__nanoclaw__send_message` with the full context (redacted), classification, and a proposed library entry the user can accept.

**Phase C: commit the cursor** (milliseconds, outside the buffer lock):

8. Write `errors_triage_cursor_ts_ms = new_cursor_ts_ms` to `heartbeat-state.json` via the heartbeat-state.json lock (its own `heartbeat-state.json.lock` per §8 registry).
9. If `unread_snapshot` was empty, exit silently (heartbeat's silence rule).

Producer writes arriving during Phase B see a released buffer lock — they append normally and their new `ts_ms` values will naturally be `> new_cursor_ts_ms`, picked up on the next triage cycle.

### Triage-of-triage filter

The triage skill itself can error — sanitizer failures, send_message timeouts, filesystem hiccups. If those got re-enqueued into the error buffer, next cycle's triage would process them and potentially re-error, amplifying.

Two guards:
- **Producer filter.** `recordError()` accepts a `source`, and any call from the triage skill's execution context passes `source = "error-triage"` — which the producer silently drops (never written). The triage skill gets this by being invoked under a distinct `NANOCLAW_SKILL_NAME=error-triage` env var or equivalent.
- **Consumer guard.** Even if the filter above leaks, the triage skill's classification library has a rule `source == "error-triage" → drop silently, count to daily_discoveries`. Defense in depth.

## Pattern library

`/workspace/trusted/error-classifications.md` — human-curated list of known classification keys (matched as `source | stable_key`) with disposition. NOT keyed by `fingerprint` — the fingerprint is an in-memory dedup key only (§Data shape):

```markdown
## Transient — count, don't alert

- `telegram-send | grammy-429-ratelimit` — Telegram rate limit. Ignore under 5/hr.
- `polling | grammy-409-conflict` — Other poller took over briefly. Ignore under 3/cycle.
- `db | sqlite-busy` — Lock contention. Ignore under 10/hr.

## Known-critical — alert always

- `telegram-send | html-parse-fail-fallback` — PR #83 territory. Should be zero post-fix; regression if it fires.
- `task-scheduler | script-missing` — Tile install corrupt; needs deploy.
- `ipc-handler | send_message-threw` — Writes may not be storing; #81 class.

## Unknown

- (Agent-proposed entries land here for Baruch to promote to transient or known-critical.)
```

## Producer integration points (Phase 1)

Concrete files + call sites to instrument. Each adds `await recordError({...})` in a `catch` block that currently only logs.

| File | Existing catch / error site | New source |
|---|---|---|
| `src/channels/telegram.ts` | HTML-parse fallback (post-#82 tracing) | `telegram-send` |
| `src/channels/telegram.ts` | `sendPoolMessage` rejections | `telegram-send` |
| `src/channels/telegram.ts` | Polling restart + 409 handling | `polling` |
| `src/ipc.ts` | JSON parse errors on IPC files | `ipc-parse` |
| `src/ipc.ts` | Top-level handler catch (`[ipc] Error processing IPC message`) | `ipc-handler` |
| `src/task-scheduler.ts` | Script launch failures, timeout wrappers | `task-scheduler` |
| `src/container-runner.ts` | Docker spawn / exit-non-zero | `container-runner` |
| `src/db.ts` | sqlite operation catch blocks | `db` |
| `src/index.ts` | Top-level `process.on('uncaughtException')` | `orchestrator` |

Each call passes `source`, `level`, a short `message`, and a `context` object.

**Redaction.** The existing `redactBotTokens` helper in `src/logger.ts` is marked `@internal` — the logger applies it at write time to every log line and application code does NOT call it directly. Two options for `recordError()`:

- **(a, preferred)** — `recordError()` calls `logger.warn({event: "server-error", ...payload})` which redacts through the existing pipeline, AND separately writes the raw payload to the JSONL buffer via a new narrow public helper `src/redact.ts::redactForBuffer(payload)`. Factor the current test-only helper logic out into this new module; keep the `@internal` constraint on the `logger.ts` caller but expose a public equivalent for the non-logger writer.
- **(b, fallback)** — Route all `recordError()` writes through `logger.warn` ONLY. Tap the existing logger's output stream (this repo's `src/logger.ts` is a custom stdout/stderr writer, not pino — taps would be done via its formatted-output hook or a sibling writer the logger module exports). Higher-coupling to logger internals, more fragile than option (a).

Option (a) lands in Phase 1 alongside the producer.

## File layout

| Path | Repo | Purpose |
|---|---|---|
| `docs/proposals/server-error-feedback.md` | private | this proposal |
| `src/error-recorder.ts` | private | `recordError()` helper + trim + fingerprint + dedup |
| `src/error-recorder.test.ts` | private | unit tests (producer-side: fingerprint stability, dedup window, trim correctness, redaction) |
| `skills/triage-errors/SKILL.md` | `nanoclaw-admin` | triage skill body |
| `skills/triage-errors/scripts/classify.py` | `nanoclaw-admin` | classification logic + cursor update |
| `skills/triage-errors/scripts/trim-buffer.py` | `nanoclaw-admin` | optional: weekly prune of entries older than 30 days |
| `trusted/error-classifications.md` | host-local `trusted/` dir | pattern library |
| `skills/heartbeat/SKILL.md` (edit) | `nanoclaw-admin` | add Step N: "invoke triage-errors skill" |

## Observability of the observer

Weekly-housekeeping reports a one-line summary:

> **Error triage this week:** N entries classified (X transient / Y known-critical / Z unknown-alerted). Pattern library has P entries.

So Baruch can see the triage is alive without grepping anything.

## Tradeoffs

- **Pro:** #81-class bugs surface within hours instead of days. The agent gets a feedback loop on its own environment. Pattern library becomes an organic runbook — patterns you name tend to stop happening.
- **Pro:** Zero risk in Phase 1 (write-only). Low risk in Phase 2 (log-only). Tier 1 alerts are gated behind a week of observation.
- **Pro:** Consolidates an error-log-paste habit Baruch already does manually during incidents.
- **Con:** Producer-side write on every error adds a tiny latency to the hot path (one fsync per event). Mitigated by the 60s dedup window — a typical cycle writes ≤10 events.
- **Con:** Classification library needs seeding. Tier 0 bootstrap means the first week of Tier 1 alerts are "mostly unknown" until the library fills.
- **Con:** Another file under `/workspace/group/` that writers need to coordinate on. Adds one row to the concurrency registry.
- **Con:** Heartbeat cycle gains a step — minor context cost (read buffer, classify, write cursor), ~200 tokens average. Absorbed within existing budget.

## Open questions

1. **Cap semantics.** Hard-trim on every write vs periodic trim task? First is simpler but makes every write do work. Leaning hard-trim for Phase 1; revisit if the CPU cost is visible.
2. **Skip-file vs SQLite.** JSONL is simple and cat-able. SQLite would give indexed dedup + structured queries, but adds schema + migration surface. JSONL wins for Phase 1; revisit if classification ever needs indexed lookups.
3. **Process vs container.** The orchestrator runs on the host; the agent container reads scripts that access the file. The buffer path `/workspace/group/...` is inside the container's mount. Host produces at `$GROUPS_DIR/<group>/server-errors.jsonl` where `GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups')` per `src/container-runner.ts`, and the container sees it as `/workspace/group/server-errors.jsonl`. Confirm this mapping holds for every group's mount (it should — the mount is generic) or document any per-group path scheme that differs.
4. **Scope of `source = "orchestrator"`.** Catch-all for uncaught exceptions is easy; but should we also capture intentional logged-warn cases (e.g. "no Telegram channel registered")? Probably not — those are warnings, not errors. Draw the line at "we caught an exception" or "we chose to log at level ≥ warn."
5. **Secret-leak defense in depth.** PR #91's `redactBotTokens` is the sanctioned redaction path for Telegram. Should `recordError` also redact known secret-env-var values from `context` fields? Conservative: yes, a short regex catch-all targeting the patterns this repo actually emits (bot-token URLs, Anthropic keys via the credential proxy, Composio API keys injected into main/trusted containers). The specific list should match `docs/SECURITY.md` §4's credential inventory, not hard-code an impl name.
6. **Cross-group replication — RESOLVED for Phase 1: main group only.** Round-4 review pointed out that `/workspace/group/` is mounted read-only-but-readable in untrusted containers; replicating the buffer to every group's folder would expose orchestrator error context (stack tails, chat JIDs, possibly other groups' chat IDs in `context`) to untrusted tiles. Phase 1 writes ONLY to the main group's `server-errors.jsonl`. Admin-tile triage runs in the main group and knows about all groups. Trusted/untrusted groups get no buffer file at all; if the triage skill ever needs to alert cross-group, it does so via its existing `send_message` channel-routing.

## Request

Looking for a review pass on the data shape (§Data shape) and the phase boundaries (§Scope phasing) before implementation. Everything else is mechanical once those are locked.

Once the shape is agreed, Phase 1 (producer) is ~2 hours of work: error-recorder.ts, unit tests, instrumentation at each site. Phases 2 and 3 ship through the admin-tile audit pipeline codified in [`docs/tile-plugin-audit.md`](https://github.com/jbaruch/nanoclaw/pull/98) (landing in sibling PR #98, merged before Phase 2 starts).

Tracked in issue TBD (will file after this PR merges).
