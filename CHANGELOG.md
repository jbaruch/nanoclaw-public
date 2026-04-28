# Changelog

All notable changes to NanoClaw will be documented in this file.

For detailed release notes, see the [full changelog on the documentation site](https://docs.nanoclaw.dev/changelog).

## [Unreleased]

- `wipeSessionJsonl` now also removes the sibling per-session tool-results directory at `<slug>/<sessionId>/` alongside the JSONL transcript (#202, follow-up to #193). The SDK writes tool-call result snapshots (image attachments, search outputs) into that directory; pre-fix it was orphaned by every scheduled-task run and by every `nukeSession` call (since the helper is shared). Implemented via a new `removeToolResultsDirInSlug` helper that mirrors `unlinkJsonlInSlug`'s lstat → branch on type → realpath-containment discipline: a symlink at the dir path is unlinked as a link (target preserved), a regular file is left alone (logs warn — not the SDK's shape), and a real directory is removed via `fs.rmSync({ recursive: true })` with `ENOENT` handled explicitly in the catch so the returned delete count stays accurate (a concurrent cleanup that vanishes the path between lstat and rm returns 0, not 1). Node's `rmSync` does not follow symlinks during recursion, so a compromised container that scattered host-pointing symlinks inside its own tool-results dir cannot redirect the wipe outward. The `wipeSessionJsonl` return count is now up to 2 per slug (1 transcript + 1 tool-results dir) rather than 0–1.
- Added `unregister_group` MCP tool — main-group only inverse of `register_group` (#159). Removes the `registered_groups` row, cascade-deletes scheduled_tasks tied to the unregistered folder, and refreshes `available_groups.json` in one call; refuses to touch the main-group registration; leaves the on-disk `groups/<folder>/` directory intact (operators delete that manually). Companion one-shot cleanup at `initDatabase()` drops the dormant `tg:1698969` / `telegram_main` row that lingered because there was no inverse path until now. Companion drift detector logs (does not auto-delete) any `registered_groups` row whose JID has no matching `chats` row at startup, so future drift surfaces immediately.
- [BREAKING] Removed the auto-create heartbeat rule for non-main groups (#158). Heartbeat is now opt-in via `containerConfig.enableHeartbeat` instead of being implicit on `requiresTrigger !== false` (a flag no group ever actually had set). Existing heartbeat rows are preserved (the startup prompt-migration still rewrites legacy prompts on any non-main row that exists), and the main-group heartbeat is unchanged. `setGroupTrigger` no longer touches heartbeat lifecycle — trigger config and heartbeat opt-in are now orthogonal. The `register_group` MCP tool exposes the new `enableHeartbeat` parameter so opt-in flows through the same channel as other registration config.
- [BREAKING] Removed the `MAX_CONCURRENT_CONTAINERS` global concurrency cap (#157). With ~10 registered groups × 2 slots, the theoretical ceiling is ~20 and the cap was more likely to delay legitimate work (e.g. a heartbeat firing alongside an inbound user message on a different group) than to prevent runaway spawn. Hardware and Docker remain the only limits worth honouring; per-group rate limits are out of scope. The `MAX_CONCURRENT_CONTAINERS` env var is now ignored.
- Pin `thinking.display: 'summarized'` on the agent-runner's `query()` call (#163). Opus 4.7 silently flipped the default to `'omitted'`, which would surface thinking blocks as empty content with an opaque encrypted signature — invisible today but a hard prerequisite for the upcoming lifecycle reaction state machine (#162) that triggers on the first thinking block with content.
- Scheduled tasks no longer resume the SDK maintenance session across discrete invocations (#193). The maintenance slot's `sessionId` was shared by every `context_mode: 'group'` task on a folder, so a prior turn's terminal message could bleed into the next run's stream — observed as a lunch reminder's `last_result` opening with heartbeat-loop language from a 6-day-old turn. Each scheduled run now starts a fresh SDK turn: no `resume: sessionId` is passed and no `newSessionId` is persisted on completion. To prevent orphan transcripts from accumulating under `data/sessions/<group>/maintenance/.claude/projects/<slug>/` (the sessionId is no longer persisted, so neither `nukeSession` nor the time-based `cleanup-sessions.sh` script can find it later), the scheduler wipes each run's JSONL via `wipeSessionJsonl` from the post-run `finally` path, after the run bookkeeping (`logTaskRun` and the `updateTaskAfterRun` attempt) has been attempted. The `MAINTENANCE_SESSION_NAME` slot still carries the per-session `.claude/` mount and parallel queue routing, so user-facing default-slot work is unaffected. The `context_mode` column is retained on the schema but no longer gates SDK resume.
- Hooks epic — `bash-safety-net` PreToolUse hook denies known-destructive Bash commands deterministically (#143). Catalogue covers `rm -rf` on root / mount-root paths (combined and split flags, end-of-options marker, trailing-slash and dot-segment variants), force-push to `main`/`master` (`--force` flag and `+refspec` syntax), `mkfs.*`, raw-disk `dd`, raw block-device redirects, `chmod -R 777`, `chown -R` on mount roots, and the canonical fork bomb. Anchored to command-start positions so prose mentions of the same tokens (e.g. `echo mkfs.ext4 docs.md`) are not flagged.
- Hooks epic — `reply-threading-enforcement` PreToolUse hook denies a standalone `mcp__nanoclaw__send_message` (no `reply_to`) when the latest user inbound is unanswered (#137). Carve-outs: `pin: true` (status updates), `sender` set (multi-bot persona), maintenance / scheduled-task session, and any `reply_to` (which marks the inbound addressed and unlocks subsequent standalones in the same turn). Single-turn enforcement only — cross-turn de-dup needs a `messages.db` query and is queued as a follow-up.
- Hooks epic — `lazy-verification-detector` Stop hook blocks end-of-turn messages that surface banned verification excuses ("site is JS-rendered", "page is thin", "can't access this", etc.) without enumerating real attempts (#135). On match, the SDK re-runs the turn with a reminder injected via `systemMessage`. Genuine-failure carve-out: messages with ≥2 `Tried X — got Y` enumerations pass through. The `nanoclaw-core/rules/no-lazy-verification.md` prose rule is fully replaced by this runtime check and is deleted in a paired tile-cleanup PR.
- Hooks epic — `composio-fidelity` PostToolUse hook flags fabricated-ID signatures in MCP tool returns (sequential `prefix_NN` ≥5 dense, `pr_notif` compound shape ≥3, `promo_NNN` ≥3) (#140). Detections append to `/workspace/host-logs/fidelity-alerts.log` and a `systemMessage` warning is injected so the agent treats the result as untrusted instead of silently quoting fabricated IDs. Tool result is NOT silently rewritten — masking the failure mode would be worse than surfacing it.
- Hooks epic — `no-markdown-in-send-message` PreToolUse hook auto-rewrites the four common Markdown leaks (`**bold**`, `[label](url)`, `` `code` ``, `- bullet` lines) to HTML before `mcp__nanoclaw__send_message` and `mcp__nanoclaw__send_file` reach the IPC layer (#138). Code-block regions (` ``` ` fences, `<pre>`, `<code>`) are passed through bytewise so the agent can quote raw Markdown samples without the hook mangling them. Link labels and bold inner content are HTML-entity-escaped to prevent stray-tag smuggling.
- Hooks epic — `path-hygiene-cadence` PreToolUse hook suppresses duplicate path-hygiene reports within a 4-hour window (#139). Signature is `<keyword>:<lc-path>` for catalogued keywords (`path-hygiene`, `orphaned`, `misplaced`, `staging-drift`); cadence persists across container restarts via the per-group daily-log mtime. Carve-outs: `pin: true` and any `reply_to` (responding to an explicit user ask). Deny reason renders the actual configured window so a custom `windowMs` doesn't lie.
- Hooks epic — `react-first` UserPromptSubmit hook synthesises an acknowledgement reaction (👀) before the model spends any tokens on a new inbound (#136). Skips on sub-agent turns, scheduled tasks, prompts wrapped as `[SCHEDULED TASK]`, and containers without a named user-facing assistant. The agent can still react with a more specific emoji later in the turn — Telegram replaces the bot's reaction on each new call, so this is a floor, not a ceiling. The "React with an emoji to acknowledge" line in `nanoclaw-core/rules/default-silence.md` is removed in a paired tile-cleanup PR.
- Hooks epic — `session-start-auto-context` SessionStart hook auto-injects MEMORY.md, RUNBOOK.md, and the most-recent daily log into the session before the first turn fires (#141). Pure file-IO, no LLM round-trip; per-file byte-cap truncation; `Date.parse`-validated daily-log filename pick. Fires only on `source === 'startup'` and skips containers without a named user-facing assistant. Replaces the implicit "read at session start" path on the `tessl__trusted-memory` skill (the skill keeps explicit memory writes).
- Hooks epic — `stop-hook-end-of-turn-audit` Stop hook (#142). Observability only — never blocks the turn. Tracks per-turn react/reply state via paired UserPromptSubmit + PreToolUse callbacks; on Stop, if neither a `react_to_message` to the triggering inbound nor a `send_message` with `reply_to === triggeringInboundId` landed, appends a JSONL entry to `/workspace/host-logs/silent-turns.log` with chat JID, message id, session id, and timing. Skips on sub-agent / maintenance-session / scheduled-task turns and on turns with no triggering inbound (orchestrator-typed text, slash commands).

## [1.2.54] - 2026-04-26

- [BREAKING] Per-group `CLAUDE.md` is now a thin trust-tier pointer (TRUSTED/UNTRUSTED marker + `@import` to SOUL.md / FORMATTING.md / MEMORY.md / RULES.md) mounted readonly from `groups/global/` at every container spawn (#153). Trust flips are reflected on the next message with no reconciliation step. Identity and behavior live in `groups/global/SOUL.md`; channel formatting in `groups/global/FORMATTING.md`; per-group writable memory in each group's new `MEMORY.md`; main-only operational content in `groups/main/ADMIN.md`. Existing installs run `tsx scripts/migrate-thin-claude-md.ts --apply` on the host to delete vanilla per-group `CLAUDE.md` copies and seed `MEMORY.md`; customized files are flagged for manual reconciliation.

## [1.2.53] - 2026-04-26

- Poison defense: `TaskOutput(block!=false)` is denied at the PreToolUse hook to stop the SDK from leaking raw sub-agent JSONL on timeout (#116). MCP tool results are scrubbed of Cf-class invisible-Unicode characters and capped at `TOOL_RESULT_MAX_BYTES` bytes (default 64 KiB) before reaching the model (#117).

## [1.2.36] - 2026-03-26

- [BREAKING] Replaced pino logger with built-in logger. WhatsApp users must re-merge the WhatsApp fork to pick up the Baileys logger compatibility fix: `git fetch whatsapp main && git merge whatsapp/main`. If the `whatsapp` remote is not configured: `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git`.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Check your runtime: `grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — if it shows `'container'` you are on Apple Container, if `'docker'` you are on Docker. Docker users: run `/init-onecli` to install OneCLI and migrate `.env` credentials to the vault. Apple Container users: re-merge the skill branch (`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`) then run `/convert-to-apple-container` and follow all instructions (configures credential proxy networking) — do NOT run `/init-onecli`, it requires Docker.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-nanoclaw` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
