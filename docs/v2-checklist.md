# NanoClaw v2 Checklist

Status: [x] done, [~] partial, [ ] not started

---

## Core Architecture

- [x] Session DB replaces IPC (messages_in / messages_out as sole IO)
- [x] Two-DB split: inbound.db (host-owned) + outbound.db (container-owned) — zero cross-process write contention
- [x] Central DB (agent groups, messaging groups, sessions, routing)
- [x] Host sweep (stale detection via heartbeat file, retry with backoff, recurrence scheduling)
- [x] Active delivery polling (1s for running sessions)
- [x] Sweep delivery polling (60s across all sessions)
- [x] Container runner with session DB mounting
- [x] Per-session container lifecycle and idle timeout
- [x] Session resume (sessionId + resumeAt across queries)
- [x] Graceful shutdown (SIGTERM/SIGINT handlers)
- [x] Orphan container cleanup on startup

## Agent Runner (Container)

- [x] Poll loop (pending messages, status transitions, idle detection)
- [x] Concurrent follow-up polling while agent is thinking
- [x] Message formatter (chat, task, webhook, system kinds)
- [x] Command categorization (admin, filtered, passthrough)
- [x] Transcript archiving (pre-compact hook)
- [x] XML message formatting with sender, timestamp
- [~] Media handling inbound (formatter references attachments, no download-from-URL)

## Agent Providers

- [x] Claude provider (Agent SDK, tool allowlist, message stream, session resume)
- [x] Mock provider (testing)
- [x] Provider factory
- [ ] Codex provider
- [ ] OpenCode provider

## Channel Adapters

- [x] Channel adapter interface (setup, deliver, teardown, typing)
- [x] Chat SDK bridge (generic, works with any Chat SDK adapter)
- [x] Chat SDK SQLite state adapter (KV, subscriptions, locks, lists)
- [x] Discord via Chat SDK
- [~] Slack via Chat SDK (adapter + skill written, not tested)
- [~] Telegram via Chat SDK (adapter + skill written, not tested)
- [~] Microsoft Teams via Chat SDK (adapter + skill written, not tested)
- [~] Google Chat via Chat SDK (adapter + skill written, not tested)
- [~] Linear via Chat SDK (adapter + skill written, not tested)
- [~] GitHub via Chat SDK (adapter + skill written, not tested)
- [~] WhatsApp Cloud API via Chat SDK (adapter + skill written, not tested)
- [~] Resend (email) via Chat SDK (adapter + skill written, not tested)
- [~] Matrix via Chat SDK (adapter + skill written, not tested)
- [~] Webex via Chat SDK (adapter + skill written, not tested)
- [~] iMessage via Chat SDK (adapter + skill written, not tested)
- [x] Backward compatibility with native channels (old adapters still work)
- [x] Channel barrel wired (src/index.ts imports barrel, skills uncomment)
- [~] Setup flow wired to v2 channels (register.ts + verify.ts updated, but channel skills don't call register yet — see docs/v2-setup-wiring.md)
- [ ] Setup communicates each group is a different agent, distinct names
- [ ] Setup vs production channel separation
- [ ] Generate visual diagram of customized instance at end of setup

## Routing

- [x] Inbound routing (platform ID + thread ID -> agent group -> session)
- [x] Auto-create messaging group on first message
- [x] Session resolution (shared vs per-thread modes)
- [x] Message writing to session DB with seq numbering
- [x] Container waking on new message
- [~] Trigger rule matching (router picks highest-priority agent, regex/mention matching TODO)

## Rich Messaging

- [x] Interactive cards with buttons (ask_user_question)
- [x] Native platform rendering (Discord embeds, buttons)
- [x] Message editing
- [x] Emoji reactions
- [x] File sending from agent (outbox -> delivery)
- [x] File upload delivery (buffer-based via adapter)
- [x] Markdown formatting
- [~] Formatted /usage, /context, /cost output (commands pass through, no rich card formatting)
- [ ] Context window visibility: show position in context, approaching compaction, when compaction happens, post-compaction state
- [ ] Threading and replies support

## MCP Tools (Container)

- [x] send_message (text, optional cross-channel targeting)
- [x] send_file (copy to outbox, write messages_out)
- [x] edit_message
- [x] add_reaction
- [x] send_card
- [x] ask_user_question (blocking poll for response)
- [x] schedule_task (with process_after and recurrence)
- [x] list_tasks
- [x] cancel_task / pause_task / resume_task
- [x] send_to_agent (writes message, routing incomplete)

## Scheduling

- [x] One-shot scheduled messages (process_after / deliver_after)
- [x] Recurring tasks via cron expressions
- [x] Host sweep picks up due messages and advances recurrence
- [x] Scheduled outbound messages (no container wake needed)
- [~] Pre-agent scripts (task kind with script field, documented but not verified)

## Permissions and Approval Flows

- [x] Admin user ID per group
- [x] Admin-only command filtering in container
- [ ] Approval flow (sensitive action -> card to admin -> approve/reject -> execute)
- [ ] Role definitions beyond admin (custom roles, per-group permissions)
- [ ] Configurable sensitive action list
- [ ] Non-main groups requesting sensitive actions
- [ ] Agent requests dependency/package install (persists via Dockerfile change, requires approval)
- [ ] Agent self-modification flow:
  - [ ] Agent requests code changes by delegating to a builder agent
  - [ ] Builder agent has write access to the requesting agent's code and Dockerfile
  - [ ] Approval modes: approve per-edit as builder works, or approve full diff at the end
  - [ ] Diff review card sent to admin showing all proposed changes
  - [ ] On approval: apply edits, rebuild container image, restart agent
  - [ ] On rejection: discard changes, notify requesting agent

## Agent-to-Agent Communication

- [~] send_to_agent MCP tool (writes message, host-side routing TODO)
- [ ] Host delivery to target agent's session DB
- [ ] Agent spawning a new sub-agent
- [ ] Internal-only agents (no channel attached)
- [ ] Permission delegation from parent to child agent
- [ ] Specialist sub-agents (browser agent, dev agent — user's agent delegates with request/approval)

## In-Chat Agent Management

- [x] /clear (resets session)
- [x] /compact (triggers context compaction)
- [~] /context (passes through, no rich formatting)
- [~] /usage (passes through, no rich formatting)
- [~] /cost (passes through, no rich formatting)
- [ ] Smooth session transitions: load context into new sessions, solve cold start problem
- [ ] MCP/package installation from chat
- [ ] Browse MCP marketplace / skills repository from chat

## Webhook Ingestion

- [ ] Generic webhook endpoint for external events
- [ ] GitHub webhook handling
- [ ] CI/CD notification handling
- [ ] Webhook -> messages_in routing

## System Actions

- [ ] register_group from inside agent (stub exists)
- [ ] reset_session from inside agent (stub exists)

## Integrations

- [ ] Vercel CLI integration in setup process
- [ ] Skills for deploying and managing Vercel websites from chat
- [ ] Office 365 integration (create/edit documents with inline suggestions)

## Memory

- [ ] Shared memory with approval flow (write to global memory requires admin approval)

## Migration

- [ ] v1 -> v2 migration skill
- [ ] Database migration (v1 SQLite -> v2 central DB + session DBs)
- [ ] Channel credential preservation
- [ ] Custom skill/code porting

## Testing

- [x] DB layer tests (agent groups, messaging groups, sessions, pending questions)
- [x] Channel registry tests
- [x] Poll loop / formatter tests
- [x] Integration test (container agent-runner)
- [x] Host core tests
- [ ] End-to-end flow tests (message in -> agent -> message out -> delivery)
- [ ] Delivery polling tests
- [ ] Host sweep tests (stale detection, recurrence)
- [ ] Multi-channel integration tests

## Rollout

- [ ] Internal testing across all channels
- [ ] Migration skill built and tested
- [ ] PR factory migrated as validation
- [ ] Blog post / announcement
- [ ] Video demos of key flows
- [ ] Vercel coordination
