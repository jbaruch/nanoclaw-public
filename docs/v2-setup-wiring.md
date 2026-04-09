# v2 Setup Wiring — Status & Remaining Work

Last updated: 2026-04-09, branch `v2`, commit `1dc5750`

## What's Done

### Two-DB Split (session DB write isolation)
- Session DB split into `inbound.db` (host-owned) and `outbound.db` (container-owned)
- Each file has exactly one writer — eliminates SQLite write contention across host-container mount
- Host uses even seq numbers, container uses odd (collision-free)
- Container heartbeat via file touch (`/workspace/.heartbeat`) instead of DB UPDATE
- Scheduling MCP tools emit system actions via messages_out; host applies them to inbound.db in `delivery.ts:handleSystemAction()`
- Host sweep reads `processing_ack` table + heartbeat file mtime for stale detection
- Container clears stale `processing_ack` entries on startup (crash recovery)
- Files: `src/db/schema.ts` (INBOUND_SCHEMA + OUTBOUND_SCHEMA), `src/session-manager.ts`, `src/delivery.ts`, `src/host-sweep.ts`, `container/agent-runner/src/db/connection.ts`, `messages-in.ts`, `messages-out.ts`, `poll-loop.ts`, `mcp-tools/scheduling.ts`, `mcp-tools/interactive.ts`
- Container image rebuilt with tsconfig excluding v1 (`container/agent-runner/tsconfig.json`)
- E2E verified: host → Docker container → Claude responds → "E2E works!" ✓

### OneCLI Integration
- `ensureAgent()` call added before `applyContainerConfig()` in `src/container-runner.ts`
- Without `ensureAgent`, OneCLI rejects unknown agent identifiers and returns false, leaving container with no credentials
- E2E verified with OneCLI credential injection ✓

### Channel Barrel
- `src/index.ts` imports `./channels/index.js` (the barrel)
- Channel skills uncomment lines in the barrel to enable channels
- Discord is uncommented by default (it was previously a direct import in index.ts)

### Setup Registration (partially)
- `setup/register.ts` rewritten to create v2 entities (`agent_groups`, `messaging_groups`, `messaging_group_agents`) in `data/v2.db`
- Accepts `--platform-id` (v2) and `--jid` (v1 compat) flags
- Added `getMessagingGroupAgentByPair()` to prevent duplicate wiring
- `setup/verify.ts` updated to check v2 central DB (counts agent groups with wiring)

### Router Logging
- `src/router.ts` logs `MESSAGE DROPPED` at WARN level when no agents wired, with actionable guidance

---

## What's NOT Done — Remaining Work for Fresh Install

### 1. v2 Channel Skills Don't Register Groups

**Problem:** The v2 channel skills (`.claude/skills/add-telegram-v2/SKILL.md`, `add-slack-v2`, `add-linear-v2`, etc.) only do:
- Install npm package
- Uncomment barrel import
- Collect credentials → write to `.env`
- Build and verify

They do NOT create agent groups, messaging groups, or wiring in the v2 central DB. Without these DB entities, the router auto-creates a `messaging_group` on first message but finds no `messaging_group_agents` → message is silently dropped (now logged as WARN).

**Fix needed:** Each v2 channel skill needs a registration phase that calls:
```bash
npx tsx setup/index.ts --step register -- \
  --platform-id "<channel-id>" \
  --name "<group-name>" \
  --folder "<agent-folder>" \
  --trigger "@BotName" \
  --channel <channel-type> \
  --is-main  # (if this is the primary group)
```

Or alternatively, add a dedicated "register groups" step to `setup/SKILL.md` between step 5 (channels) and step 6 (mounts). This step would:
1. Ask the user how many agent groups they want
2. For each group: name, folder, which channels it handles, trigger pattern, session mode
3. Call `setup/register.ts` for each

### 2. v1 add-discord Skill is Incompatible

**Problem:** Setup SKILL.md line 263 references `/add-discord` (v1 skill). This skill:
- Tries to merge a branch (`feat/discord`)
- Uses `--jid "dc:<id>"` format
- References `store/messages.db` for verification
- Creates a v1 DiscordChannel class (we now use Chat SDK)

**Fix needed:** Either:
- Create a `/add-discord-v2` skill matching the pattern of other v2 skills
- Or update the existing `/add-discord` skill for v2
- Update `setup/SKILL.md` line 263 to reference the correct skill

### 3. Setup SKILL.md Missing Group Registration Step

**Problem:** The setup flow (steps 0-9) has no step for creating agent groups. Channels get configured (step 5) but nobody creates the v2 entities needed for routing.

**Fix needed:** Add a step (probably between current step 5 and 6, or as part of step 5) that:
1. Asks "What do you want to name your assistant?" (already partially handled by `--assistant-name`)
2. Asks which channel+platform-id is the primary/admin channel
3. Creates the agent_group with `is_admin=1`
4. Creates messaging_group + messaging_group_agents wiring
5. Optionally creates additional non-admin agent groups

The v1 flow embedded this in each channel skill's "Register" phase. The v2 flow should either do the same (add register calls to each v2 channel skill) or centralize it.

### 4. Setup Groups Step (`setup/groups.ts`)

Check if `setup/groups.ts` exists and what it does. It may need updating for v2 or may need to be created.

### 5. Channel Skills Should Know Channel Type

Each v2 channel skill knows its channel type (discord, telegram, slack, etc.) but the registration args need the platform-specific channel/group ID which the user must provide. The skill should ask for this during Phase 3 (Setup) and then call register.

### 6. Verify Step Channel Auth Check

`setup/verify.ts` currently checks for a limited set of channel tokens:
- TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, DISCORD_BOT_TOKEN
- WhatsApp auth dir

It should also check for v2 channel tokens:
- GITHUB_TOKEN, LINEAR_API_KEY, GCHAT_CREDENTIALS, TEAMS_APP_PASSWORD, etc.

---

## Architecture Reference

### v2 Entity Model
```
agent_groups (id, name, folder, is_admin, agent_provider, container_config)
    ↕ many-to-many
messaging_groups (id, channel_type, platform_id, name, is_group, admin_user_id)
    via
messaging_group_agents (messaging_group_id, agent_group_id, trigger_rules, session_mode, priority)
```

### Message Flow
```
Channel adapter → routeInbound() → resolve messaging_group → resolve agent via messaging_group_agents
→ resolve/create session → write to inbound.db → wake container → agent-runner polls inbound.db
→ agent responds → writes to outbound.db → host delivery poll reads outbound.db → deliver via adapter
```

### Key Files
| File | Purpose |
|------|---------|
| `src/index.ts` | v2 entry point, imports channel barrel |
| `src/channels/index.ts` | Channel barrel — uncomment to enable |
| `src/router.ts` | Inbound routing, auto-creates messaging groups |
| `src/session-manager.ts` | Creates inbound.db + outbound.db per session |
| `src/delivery.ts` | Polls outbound.db, delivers, handles system actions |
| `src/host-sweep.ts` | Syncs processing_ack, stale detection, recurrence |
| `src/container-runner.ts` | Spawns containers, OneCLI ensureAgent + applyContainerConfig |
| `setup/register.ts` | Creates v2 entities (agent_group, messaging_group, wiring) |
| `setup/verify.ts` | Checks v2 central DB for registered groups |
| `container/agent-runner/src/db/connection.ts` | Two-DB connection layer (inbound read-only, outbound read-write) |
