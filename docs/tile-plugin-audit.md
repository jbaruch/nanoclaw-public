# Tile Plugin Audit Checklist

Rules for auditing `nanoclaw-core`, `nanoclaw-trusted`, `nanoclaw-untrusted`, `nanoclaw-host`, and any future tile. Synthesised from:

- **[Agent Skills specification (agentskills.io)](https://agentskills.io/specification)** — open standard published by Anthropic + cross-vendor partners Dec 2025. Authoritative on frontmatter fields, directory layout, size limits.
- **[Anthropic's Agent Skills engineering post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)** — progressive disclosure model, evaluation-first design.
- **[Tessl skill optimize/review](https://docs.tessl.io/evaluate/optimize-a-skill-using-best-practices)** — the rubric the tile-repo GHA runs at 85% threshold.
- **Our own 5-PR `nanoclaw-admin` audit (#27–#31, Apr 2026)** — concrete patterns Copilot flagged across 8 review rounds.

Each item below traces to one of those sources; items marked with *(observed)* came directly from the admin-tile PR feedback, not theory.

---

## 0. Pre-flight

Before touching any skill, do these three:

- [ ] **`tessl skill review` baseline.** Record current score per skill. Don't claim "improvement" without a before/after number. Goal: every skill ≥85% (the GHA gate); stretch goal ≥90% (the `--optimize` iteration ceiling). Run with `tessl skill review skills/<skill>/SKILL.md --json | jq -r '.review.reviewScore'` for a machine-readable integer. Loop across every `skills/*/SKILL.md` to produce the per-tile baseline table.
- [ ] **Count fenced Python blocks per skill** — anything >0 is a candidate for §4 triage. One-liner:

    ```bash
    for f in skills/*/SKILL.md; do
      # Parameter expansion avoids the $(basename $(dirname ...)) nesting,
      # which would mis-quote paths containing spaces.
      skill=${f#skills/}
      skill=${skill%/SKILL.md}
      n=$(grep -c '^```python$' "$f")
      printf '%-25s  %d py-blocks\n' "$skill" "$n"
    done
    ```
- [ ] **Read the tile's existing convention files.** `rules/*.md`, `references/*.md`. A rule that contradicts existing tile conventions belongs in a discussion PR, not an audit PR.

## 1. Frontmatter hygiene *(agentskills.io spec)*

- [ ] `name` — 1–64 chars, `[a-z0-9-]`, no leading/trailing hyphen, no `--` consecutive, matches parent directory name.
- [ ] `description` — 1–1024 chars. Describes BOTH what the skill does AND when to use it. Includes specific trigger phrases a user / upstream agent would naturally say ("check inbox", "run nightly sync", etc.).
- [ ] **No `<` or `>` in frontmatter values** — XML brackets inject unintended instructions into system prompts on some agents.
- [ ] `license`, `compatibility`, `metadata`, `allowed-tools` — optional. Include only when applicable. `compatibility` should be set when the skill needs specific system packages or Python versions.

### Cross-tile uniqueness *(observed — inventory run 2026-04-21)*

Tiles are independent repos but their skills co-install into the same agent container under `/home/node/.claude/skills/tessl__<name>/`. Two skills with the same `name` across different tiles = whichever tile installs last wins; the other is silently shadowed. Current registry has two real collisions:

- `check-system-health` — exists in both `nanoclaw-admin` and `nanoclaw-trusted`
- `trusted-memory` — exists in both `nanoclaw-admin` and `nanoclaw-trusted`

Rules:

- [ ] Grep every tile's `skills/*/` directory for the skill name — any cross-tile duplicate is a bug unless the override is explicitly documented (which tile wins and why).
- [ ] Prefixing with the tile name (e.g. `admin-check-orders`) is NOT the current convention — most skills are unprefixed and rely on the `tessl__` runtime prefix for namespacing. Don't introduce a prefix convention in this audit; resolve collisions by renaming one side or consolidating.
- [ ] Rules follow the same co-install rule (`rules/*.md` names merge across tiles). No current rule collisions — confirm via grep before adding a new rule with a generic name.

### Anti-patterns *(spec + observed)*

- Description reads as a capability statement without trigger phrases ("Creates sophisticated multi-page docs"). The agent can't match this against a user request.
- Description <100 chars when the skill has real surface area — under-described skills get skipped.
- Name uses underscores, capitals, or dots.

## 2. SKILL.md body hygiene

- [ ] **Body ≤5000 tokens, ≤500 lines** per the agentskills spec. Our heavier admin tile skills have been at the limit — the Copilot optimizer flags it implicitly via verbosity scoring.
- [ ] **Lean body + progressive disclosure.** See §3. Detailed tables, long error-handling matrices, API shape docs → move to `references/`. Executable logic → move to `scripts/`.
- [ ] **Numbered sequential steps** where order matters. Agents follow numbered prose more reliably than narrative.
- [ ] **Each step is actionable.** No meta-commentary about what you're about to do; just do it.
- [ ] **"Silence when nothing to report"** directive where applicable — this is a standing nanoclaw convention.
- [ ] **Output examples** for anything non-trivial. Shows what "correct" looks like.
- [ ] **Hard rules callout at the top** for any global invariant (e.g. heartbeat's "NEVER set the `sender` parameter"). Bolded, fronted.

### Example-block correctness *(observed — proposal review on #97)*

- [ ] **JSON/JSONC examples are valid JSON(C).** `"level": "warn" | "error"` is TypeScript union syntax, NOT valid JSONC — parsers reject it and agents pattern-matching on the field see the literal `|`. Use a concrete value (`"level": "warn"`) + comment listing allowed values.
- [ ] **Path pinning.** When the text says "today's daily file" / "the heartbeat state" / "the pending queue", the very next sentence pins the absolute path (`/workspace/trusted/memory/daily_discoveries.md`, `/workspace/group/heartbeat-state.json`, etc.) — no hand-wave references for agents to resolve.
- [ ] **Cross-doc references land.** Every `see docs/foo.md` / `per rules/bar.md` reference must point to a file that exists on the default branch at merge time. If you're referencing a doc from a PR that hasn't merged yet, annotate: `(landing in #98 — merged before this ships)`.
- [ ] **API-boundary awareness.** Before a SKILL.md tells the agent to call helper `foo()`, verify `foo` is actually public API (not `@internal` / test-only). Private helpers are stable for their owner, not for external callers.

### Anti-patterns *(observed)*

- Unnecessary introductory sentences that don't advance the workflow (Tessl optimizer strips these).
- Redundant inline explanations for obvious concepts (ditto).
- Multi-paragraph prose where a table would serve.

## 3. Progressive disclosure *(Anthropic + spec)*

Three levels — keep each lean:

1. **Metadata** (~100 tok per skill) — the YAML frontmatter, always in context.
2. **SKILL.md body** (<5000 tok) — loaded when the skill is activated.
3. **Resources** — `scripts/`, `references/`, `assets/` — loaded ONLY when the body references them.

### The `scripts/` vs `references/` distinction

- `scripts/` → **executable code**. Run via subprocess; output enters context, source does NOT. For logic that's called every run.
- `references/` → **documentation the agent reads on demand**. Full file enters context when referenced. For long tables, API shapes, edge-case cookbooks, alternate-mode cheat sheets.
- `assets/` → **static templates, images, data files**. Used as-is; not read into context as prose.

### Rules *(spec)*

- [ ] Keep file references **one level deep** from `SKILL.md` (`references/foo.md` OK, `references/legal/gdpr/rules.md` not OK).
- [ ] Each reference file is focused — one topic per file. Smaller files = less context per load.
- [ ] Mutually-exclusive contexts live in separate reference files. E.g. "trusted-mode rules" and "untrusted-mode rules" should not be the same file.

## 4. Inline code → script OR reference extraction

This is the heuristic that generated 5 of our 5 admin-tile audit PRs.

### Extract to `scripts/` (executable) when ANY of:

- More than ~10 lines of non-trivial logic inline.
- Same logic duplicated across two or more skills.
- Correctness hazards the reader can't audit by eye — timezone math, atomic writes, cryptographic hashing, state-machine mutations.
- Agent would re-type the code into a Bash tool invocation on every run.
- Behavior would benefit from test coverage or version pinning.
- Subprocess calls with specific error-handling contracts the caller must implement.

### Extract to `references/` (on-demand docs) when:

- Long tables (error codes, field schemas, status matrices) that aren't needed every run.
- Per-mode / per-platform variations the skill's main flow only hits sometimes.
- Extended examples that illustrate edge cases.
- Verbose rationale or design-history notes.

### Keep inline when ALL of:

- 1–5 lines, no error-handling contract.
- Demonstrates a principle rather than executing production logic (pedagogical / example).
- Trivial file read (`open` + `json.load`, `os.path.getmtime`).
- API shape demo (e.g. showing a Composio tool call pattern).

### Schema-mismatch gate (pre-extraction) *(observed — PR #30 CFP)*

Before extracting a state-file mutation, grep the whole repo for that file. Confirm:
- Top-level shape (dict / list / slug-keyed).
- Field names (`deadline` vs `cfp_deadline`).
- Status vocabulary.

If the inline block assumed a different schema than reality, it was a no-op. **Preserving a no-op in a script is worse than leaving the inline — it's more visible.** Either redesign the semantics AND document the change, OR drop the extraction from the audit PR and file a follow-up issue.

## 5. Script quality *(observed across all 5 admin PRs)*

### Read paths

- [ ] Catch `OSError` alongside `FileNotFoundError` (`PermissionError`, `EIO`).
- [ ] Catch `UnicodeDecodeError` alongside `JSONDecodeError`.
- [ ] `isinstance(data, dict)` guard after `json.load` before indexing.
- [ ] `isinstance(data["key"], expected_type)` for nested structures the code will index.

### Write paths

- [ ] Atomic: `tempfile.NamedTemporaryFile(delete=False)` → write → flush → `fsync` → `chmod` → `os.replace`.
- [ ] Preserve mode: `os.stat(target).st_mode & 0o777` before write, `os.chmod(tmp, mode)` before `os.replace`. Default 0o644 when target doesn't exist.
- [ ] Tmpfile cleanup in `finally` if `os.replace` didn't consume it (unlink + stderr log on cleanup failure; never silently swallow).
- [ ] Read-back verification after `os.replace` — re-open + `json.load`, exit 1 loudly on corruption.
- [ ] `encoding='utf-8'` on tempfile open, `ensure_ascii=False` on `json.dump`.
- [ ] `fcntl.LOCK_EX` on `<path>.lock` for any multi-writer state file (see §8 registry).
- [ ] **Lock-mode consistency across sections of the same script or doc.** When the design takes `LOCK_EX`, failure-mode narratives describe mid-op crashes, NOT "concurrency overlap" (the lock prevents that). If a read can safely use `LOCK_SH`, say so explicitly and justify; don't silently split modes across paragraphs.
- [ ] **`OSError` catch around `json.dump`/`fsync`/`chmod`/`os.replace`** — disk-full, permission, EIO all surface as `OSError`. The common `try/finally` that handles tmpfile cleanup is not the same as catching the write error. Log a single-line `<script-name>: write failed for <path>: <err>` diagnostic; let the finally block clean the tmp; exit 1 AFTER the finally so any surrounding `flock` release still fires.
- [ ] **`OSError` catch around `fcntl.flock(...)`** — flock itself can fail (interrupted syscall, resource limits). Without a catch the caller sees a traceback instead of the documented exit-1 contract.

### Subprocess paths

- [ ] Catch `OSError` (launch failure), `CalledProcessError` (non-zero exit), `UnicodeDecodeError`/`UnicodeEncodeError`.
- [ ] Catch-all `except Exception` backstop with stderr + exit 1 **if the script has a fail-closed contract** (sanitizer wrappers, security gates). Never let tracebacks leak past a documented contract. `BaseException` stays uncaught.
- [ ] Existence check for referenced script up front (`os.path.isfile`) so the "missing script" diagnostic names the right component.
- [ ] `sqlite3.connect(..., timeout=N)` — never connect without a timeout on busy DBs. Convention: 5–15s.

### Stdout / stderr contract

- [ ] Success → stdout only, no extra noise.
- [ ] Failure → stderr diagnostic with `<script-name>:` prefix.
- [ ] `BrokenPipeError` on stdout write → quiet exit 0 via `os.dup2(devnull, stdout)` + `os._exit(0)`. Reference implementation in the `nanoclaw-admin` tile: [`skills/heartbeat/scripts/sanitize-html.py`](https://github.com/jbaruch/nanoclaw-admin/blob/main/skills/heartbeat/scripts/sanitize-html.py) (search for `BrokenPipeError`). Plain `except BrokenPipeError: pass` still triggers "Exception ignored in: ..." on interpreter shutdown.
- [ ] **`UnicodeEncodeError` on stdout write** — `sys.stdout` has a locale-dependent encoding; `result.stdout` may contain code points the locale can't represent. Catch alongside `OSError` on the final write.
- [ ] Other stdout failures → exit 1 with stderr diagnostic.

### CLI contract

- [ ] Exit 0 — success.
- [ ] Exit 1 — validation / runtime failure (structurally-valid input, constraint violated).
- [ ] Exit 2 — usage error (wrong arg count, wrong type, malformed structure, negative value where non-negative required).
- [ ] Arg validation against a safe charset (e.g. `^[a-z0-9_-]+$`) before using as a state-key component.
- [ ] Numeric args: validate upper/lower bounds BEFORE math (prevents `OverflowError`).
- [ ] Document exit codes in docstring AND verify the table matches actual behavior.
- [ ] **Usage line matches arg tolerance.** If the code treats zero args as a valid no-op, usage reads `[<arg> ...]`, not `<arg> [<arg> ...]`. If extra args aren't tolerated (mostly they shouldn't be — silently ignoring a typoed `path1 path2` masks bugs), reject `len(sys.argv) > N` with an explicit usage-error exit.
- [ ] **Single exit-code category per condition.** The same error classified as exit 2 in one code path and exit 1 in the docstring table is the #1 round-5 regression. Grep every `sys.exit()` + match against the table before merging.

### Datetime handling

- [ ] Explicit `.astimezone(timezone.utc)` for UTC arithmetic. Don't rely on variable naming.
- [ ] Reject naive datetimes explicitly.
- [ ] `endswith("Z")` + slice for Z → `+00:00`. NOT `.replace("Z", ...)`.
- [ ] Variable names match reality (`event_utc` only after the astimezone call).
- [ ] **Align all timestamps in one record to one clock.** Don't mix `date.today()` (local) with `datetime.now(timezone.utc)` in the same write — near-midnight runs will stamp `date` as yesterday while `fetched_at` says today. Pick one (usually UTC, matching nanoclaw's daily-log filename convention) and derive every field from the same `now_utc = datetime.now(timezone.utc)`.
- [ ] **Fallback ladder consistency for env/state-file lookups.** Three things must agree: (a) the ladder order and what's "soft" (proceed with note) vs "hard" (exit 1), (b) the stderr diagnostic fires at every ladder tier that actually produces the result (not just the outermost), (c) the exit-code table in docstring and SKILL.md describes soft vs hard explicitly.

### Hashing / stable IDs

- [ ] Document canonical encoding in SKILL.md — `value.encode('utf-8')`, no trimming / case-folding / normalisation. Stored value is hashed verbatim; downstream normalisation breaks id stability silently.

### Type annotations

- [ ] Use `Optional[str]` from `typing` instead of `str | None`. PEP 604 is 3.10+; `typing.Optional` parses on 3.8/3.9 too.

### Cross-script contract awareness

- [ ] **If another script reads your output, check its schema requirements.** Concrete example: the `nanoclaw-admin` tile's weekly system-audit (`skills/weekly-housekeeping/scripts/system-audit.py` in that repo) declares `"required": ["fetched_at"]` for `nanoclaw-state.json`; a script that writes the file but skips `fetched_at` produces audit findings every week. Before shipping a state-mutating script, grep the tile it belongs to (and any tile that installs alongside it) for readers of the same file and confirm you're meeting every required field.
- [ ] Document the contract in the writer's docstring so future edits of either side can find the dependency.

## 6. SKILL.md coupling quality

### Script invocation blocks

- [ ] Absolute install path `/home/node/.claude/skills/tessl__<skill>/scripts/<name>.py`. Never relative-looking `scripts/<name>.py` in prose when the code block below shows absolute.
- [ ] Shell invocation blocks use a `bash`-tagged fenced code block (three backticks + `bash` + newline + command + three backticks), not an untagged fence. Gets syntax highlighting + cross-file consistency.
- [ ] NO literal `[--flag]` brackets inside code fences — argparse rejects them. Show two explicit invocations (flag omitted / flag present) when the flag is conditional.

### Caller snippets

- [ ] When `subprocess.run(..., capture_output=True)` is shown, the caller MUST forward `result.stderr` on non-zero returncode. Otherwise capture swallows the diagnostic and operators lose triage signal.
- [ ] Callers branch on `.returncode`, not on exception types.

### Source-of-truth clarity

- [ ] When a rule appears in a memory file AND an enforcement table, name which is authoritative at runtime.
- [ ] Explicitly state when two locations must be updated together ("same change").

### Field persistence

- [ ] If Step N uses a field, Step 3's (or equivalent "parse / extract") schema MUST document that field as persisted.
- [ ] Document handling of historical records missing new fields.

### Matching semantics

- [ ] Document email-address matching as case-insensitive; strip `"Display Name" <addr>` wrapping.
- [ ] Document multi-recipient header handling (comma-separated; match if ANY recipient matches).
- [ ] Substring vs exact vs suffix — pick one per field and name it.

## 7. Exit code discipline

- `0` — success
- `1` — validation / runtime failure
- `2` — usage error

Common drift: the same condition classified differently across the code and the docstring table. Before merging, grep every `sys.exit()` in the script and verify a corresponding row exists in the docstring's exit-code table AND in any SKILL.md table that documents exits.

## 8. State-file concurrency registry

Each mutable state file under `/workspace/group/` has (or should have) a documented convention. Record in a central rule file. Current known conventions — extend this when a new shared-state file lands:

| File | Convention | Writers |
|------|------------|---------|
| `session-state.json` | `fcntl.LOCK_EX` on `session-state.json.lock` | `heartbeat-precheck`, `register-session`, `append-seen-ids`, default-session `pending_response`/`muted_threads` |
| `heartbeat-state.json` | `fcntl.LOCK_EX` on `heartbeat-state.json.lock` (upgraded in PR #29 round 7 — heartbeat cycle runtime can stretch past nightly kickoff on slow composio fetches, so the three writers can overlap) | `mark-phase-complete` (heartbeat/nightly/weekly callers) |
| `nanoclaw-state.json` | `fcntl.LOCK_EX` on `nanoclaw-state.lock` for every read-modify-write touching `resumable_cycles.<skill_name>` (multi-writer; expanded from the pre-#93 single-writer atomic-rename convention because the original maintenance run, every continuation in the chain, and any user-invoked skill that touches unrelated keys all share the same file). Strict order per RMW: acquire lock → read JSON → mutate only the targeted key (preserving siblings) → temp-file + `fsync` + rename → read-back verify under lock → release lock. The `schedule_task` IPC call that fires the next continuation MUST land AFTER the lock-protected write has committed and verified. Owner of the lock protocol: `tessl__resumable-cycle` skill (`jbaruch/nanoclaw-admin` tile, schema in `skills/resumable-cycle/state-schema.md` per `rules/stateful-artifacts.md`). | `tessl__resumable-cycle` (chain bookkeeping under `resumable_cycles.<skill>`), `tessl__nightly-housekeeping` / `tessl__weekly-housekeeping` / `tessl__morning-brief` (final-step clear-and-mark-complete), `mark-email-checked`, check-email cursor update, plus any future skill that touches unrelated top-level keys |
| `nanoclaw-state.lock` | Sidecar advisory-lock file for `nanoclaw-state.json`. Existence is incidental; flock state is the contract. Created by whichever writer touches `nanoclaw-state.json` first; never deleted (deletion would race with a concurrent acquirer and silently break exclusion). Per the multi-writer protocol on the row above, every reader of `resumable_cycles.<skill_name>` also acquires this lock — readers must observe a fully-committed RMW, never the temp-file half-state. | Same writer set as `nanoclaw-state.json` — they share the lock, that is the whole point |
| `task-tz-state.json` | Atomic write per `rules/follow-me-two-phase-lock.md` | `task-tz-sync`, housekeeping Phase C lock acquisition |
| `server-errors.jsonl` (proposed, #97) | `fcntl.LOCK_EX` on `server-errors.jsonl.lock` for both host producer and admin triage consumer | orchestrator `recordError()` (producer), admin `triage-errors` skill (consumer) |

## 9. Security audit *(Anthropic guidance)*

For each script in `scripts/`:

- [ ] Review for unexpected outbound network calls that don't match the skill's stated purpose.
- [ ] Review for credential / token reads that aren't documented. **Authoritative sources, in order:** (1) the per-tier table in `docs/SECURITY.md` §4, (2) `CONTAINER_VARS` in `src/container-runner.ts` (the actual runtime forwarding list). If `docs/OPERATIONS.md` or any other prose describes a credential as living inside a container when §4 + the runtime do not forward it, the prose is out of date and the audit follows §4 + code. Today's shape per §4: **Anthropic** via the host credential proxy (placeholder key in container env); **Composio** env-injected for main/trusted only (no proxy indirection); **other services** (GitHub, Google, Reclaim, TripIt, OpenAI, etc.) live on the host and are reached through host scripts via IPC. Untrusted tier gets no credentials at all. "Containers never see API keys" is only true for Anthropic — Composio keys DO land in main/trusted container envs, which is fine because those tiers are trusted, but audit rules should not overclaim the isolation. Tile scripts should not read credentials from paths §4 doesn't sanction (e.g., reading `.env` directly, reading other groups' state, etc.).
- [ ] Review for file access outside the documented workspace paths (`/workspace/group/`, `/workspace/trusted/`, `/workspace/store/`). Per-trust-level mount restrictions live in `docs/SECURITY.md` §2 — untrusted tier in particular has tighter bounds (read-only group folder, no `/workspace/trusted` mount, filtered DB).
- [ ] Silent error suppression in production script code (`|| true`, `2>/dev/null`, bare `except: pass`, empty `catch {}`) — avoid unless there's a specific documented reason (and the reason lives in a comment on the line). SKILL.md prose examples that demonstrate "this command can't fail for purpose X" are exempt from this rule — they're illustrative, not operational.

For each SKILL.md:

- [ ] No instructions directing the agent toward untrusted external endpoints.
- [ ] No "paste your token here" flows — credentials flow through the host credential proxy (see `docs/SECURITY.md` §4), never via user-pasted values in SKILL.md. Untrusted-tier skills in particular get no credentials at all.

## 10. Hygiene items (even without an extraction pass)

- [ ] Missing mode preservation on any existing atomic writer.
- [ ] `.replace("Z", ...)` anywhere → switch to `endswith` slice.
- [ ] `sqlite3.connect` without timeout.
- [ ] Inline Python helpers duplicated verbatim between skills — consolidate or reference.
- [ ] Docstring exit-code tables that don't match the code.
- [ ] Over-narrow exception handlers where broader `except Exception` would match the stated fail-closed contract.
- [ ] `str | None` annotations → `Optional[str]`.
- [ ] XML brackets in frontmatter.
- [ ] `date.today()` used where the matching `datetime.now(timezone.utc)` is in the same record (timezone drift near midnight).
- [ ] Mixed strip/non-strip for the same string argument (e.g. empty-check vs slice-parse seeing different values).
- [ ] Silently-ignored extra argv entries where zero or one is expected.
- [ ] `os.environ.get('TZ', 'UTC')` (or similar) without guarding against empty-string values — `ZoneInfo('')` crashes.
- [ ] Docstring / SKILL.md claims "normalises every failure to exit 1" or similar absolute — narrow the claim to exclude `KeyboardInterrupt` / `SystemExit` / signals.

## 11. Workflow

Recommended pass order per tile:

1. **Pre-flight** (§0) — baseline `tessl skill review` scores, grep inline Python blocks.
2. **Per-skill triage** — each inline block classified keep-inline / extract-to-scripts / extract-to-references (§3 + §4).
3. **Schema-mismatch gate** (§4) for every extraction candidate before committing.
4. **Batch related extractions into per-theme PRs.** Don't mix themes — Copilot reviews and merges cleaner.
5. **Per PR: apply §5, §6, §7 line by line.** Push, summon Copilot via `requestReviews` GraphQL (bot ID `BOT_kgDOCnlnWA`), cycle fixes until no file-level comments return, merge.
6. **Separate SKILL.md hygiene pass** for §1, §2, §9 even when no extraction happens.
7. **Update §8 registry** if any new shared-state file surfaced.
8. **Re-run `tessl skill review`** — record the new score per skill. Target ≥85%, stretch ≥90%.

---

## Per-tile tracking issue template

When opening an audit issue against a tile repo:

```markdown
# Audit: <tile-name>

Applying docs/tile-plugin-audit.md.

## Baseline
- [ ] `tessl skill review` scores captured (per skill)
- [ ] Inline Python block count: <N> (across <M> skills)

## Per-skill triage
<generated from grep output>

## Checklist progress
- [ ] §1 Frontmatter hygiene
- [ ] §2 SKILL.md body hygiene
- [ ] §3 Progressive disclosure correctness (scripts/ vs references/)
- [ ] §4 Inline-code extractions (batched as per-theme PRs)
- [ ] §5 Script quality (per extracted script)
- [ ] §6 SKILL.md coupling quality
- [ ] §7 Exit code discipline
- [ ] §9 Security audit
- [ ] §10 Hygiene items
- [ ] New rows in §8 concurrency registry (if applicable)

Close when: all boxes ticked OR remaining items filed as follow-up issues.
```

---

## Source trail

Every rule traces to one of:

- **Spec** — [agentskills.io/specification](https://agentskills.io/specification)
- **Anthropic** — [equipping-agents-for-the-real-world-with-agent-skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- **Tessl** — [optimize-a-skill-using-best-practices](https://docs.tessl.io/evaluate/optimize-a-skill-using-best-practices)
- **Observed** — `nanoclaw-admin` PRs #27 (check-orders), #28 (sanitize-wrapper), #29 (mark-phase-complete), #30 (scheduler-timezone), #31 (state writers) — Apr 2026 audit, 8 Copilot review rounds. Convergence trail: average 5–6 comments in round 1, shrinking to 1–3 per round as coverage tightened; #28/#30/#31 cleared at round 8, #29 continued through a flock/OSError revision after adopting the lock in round 7.

---

## 12. Design / proposal doc hygiene *(observed — PR #97 review)*

Rules that apply specifically to proposal docs (`docs/proposals/*.md`) and any cross-cutting design note, not the per-tile SKILL.md audit. Use this section when reviewing a new proposal PR before starting implementation.

- [ ] **Phase boundaries explicit.** Each phase of the proposal names (a) what ships in it, (b) what the prior phase must have landed, (c) the risk gate before starting the next phase. "Ship Phase 1, observe for a week, then Phase 2" is better than "these three phases are shippable in any order."
- [ ] **API-boundary awareness.** If the proposal says "the new code calls helper `foo()`", grep the target module for `@internal` / `@private` / test-only annotations on `foo`. Private helpers are stable for their owner, not for new callers. Propose either promoting to public API OR using a public alternative.
- [ ] **Cross-doc references.** Every reference to another doc must resolve. Either the doc exists on `main`, lands in the same PR, or is explicitly annotated as landing in a sibling PR (`see docs/X.md, landing in #NN`).
- [ ] **Lock/narrative consistency.** If the proposal takes `LOCK_EX`, the failure-mode section shouldn't describe "concurrency overlap" — that's what the lock prevents. Describe what actually can go wrong under the documented locking regime (usually: mid-op crash leaving partial state).
- [ ] **Behavior/schema coherence.** Every behavior the prose describes must have fields in the schema to represent it. "Bump a counter on the prior line" needs a counter field; "mark as processed" needs a processed flag; otherwise either add the schema field or simplify the behavior.
- [ ] **Reserved enum values.** When the proposal enumerates a fixed set and uses a value outside it (e.g., for filtering), document the reserved value in the enum itself, not as an afterthought in a different section.
- [ ] **Open questions are actionable.** Each listed open question should have (a) what happens if we don't decide, (b) the default if deferred, (c) who should decide. Avoid philosophical open questions that don't block implementation.
- [ ] **Scope phasing prefers "ship + observe" over "ship all at once".** A proposal with 3 phases and Phase-N dependencies on Phase-N-1 observations is more likely to land than one that implies a single big bang. Copilot won't enforce this but it's a hard-earned lesson.

## 13. Tessl skill review baseline (per-tile snapshot, 2026-04-21)

Reference data from the inventory run; the per-tile tracking issues (§11) carry the expanded per-skill tables.

| Tile | Skills | Median score | Minimum | Skills at max (100) |
|------|--------|--------------|---------|---------------------|
| `nanoclaw-admin` | 29 | 90 | 85 | 6 |
| `nanoclaw-core` | 2 | 97 | 94 | 1 |
| `nanoclaw-trusted` | 2 | 95 | 90 | 1 |
| `nanoclaw-untrusted` | 1 | 100 | 100 | 1 |
| `nanoclaw-host` | 7 | 97 | 90 | 3 |

All skills across all tiles are ≥85 (the GHA gate). Audit value is therefore NOT in score recovery — it's in (a) cross-tile name collisions (§1), (b) inline-code extractions where they exist (§4, admin had 5 extraction PRs; other tiles have ≤3 candidates total), (c) §5–§10 structural rules that `tessl skill review` doesn't check.
