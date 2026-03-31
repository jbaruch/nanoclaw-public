---
name: manage-groups
description: Add, remove, list, or configure NanoClaw groups and channels. Use when the user asks to register a new WhatsApp/Telegram/Slack group, remove a group, list registered groups, configure sender allowlists, or add directory mounts to a group container.
---

# Manage Groups

## Finding Available Groups

Available groups are provided in `/workspace/ipc/available_groups.json`. This file has two top-level keys: `groups` (the synced list of all discoverable groups) and a JID-keyed map of registered groups (see [Registered Groups Config](#registered-groups-config) below). The `groups` array looks like:

```json
{
  "groups": [
    { "jid": "120363336345536173@g.us", "name": "Family Chat", "isRegistered": false }
  ],
  "lastSync": "2026-01-31T12:00:00.000Z"
}
```

Groups are ordered by most recent activity. The list is synced daily.

If a group the user mentions isn't in the list, request a fresh sync and re-read `available_groups.json`:

```bash
echo '{"type": "refresh_groups"}' > /workspace/ipc/tasks/refresh_$(date +%s).json
```

**Fallback**: Query the SQLite database directly:

```bash
sqlite3 /workspace/store/messages.db "
  SELECT jid, name, last_message_time
  FROM chats
  WHERE jid LIKE '%@g.us' AND jid != '__group_sync__'
  ORDER BY last_message_time DESC
  LIMIT 10;
"
```

## Registered Groups Config

Registered groups are stored in `/workspace/ipc/available_groups.json` as a JID-keyed dictionary at the top level (separate from the `groups` sync array):

```json
{
  "1234567890-1234567890@g.us": {
    "name": "Family Chat",
    "folder": "whatsapp_family-chat",
    "trigger": "@Andy",
    "added_at": "2024-01-31T12:00:00.000Z"
  }
}
```

Non-obvious fields:
- **requiresTrigger**: Whether `@trigger` prefix is needed (default: `true`). Set to `false` for solo/personal chats where all messages should be processed
- **isMain**: Whether this is the main control group (elevated privileges, no trigger required)

## Adding a Group

1. Query the database or `available_groups.json` to find the group's JID
2. Use the `register_group` MCP tool with the JID, name, folder, and trigger:
   ```
   register_group(
     jid="120363336345536173@g.us",
     name="Family Chat",
     folder="whatsapp_family-chat",
     trigger="@Andy",
     requiresTrigger=false,       # omit if trigger is needed
     containerConfig={"trusted": true}  # pass for trusted groups
   )
   ```
   **Trust level** via `containerConfig`:
   - **"trusted"** → `containerConfig={"trusted": true}` — full access (files, Composio, host scripts)
   - **"untrusted"** → omit `containerConfig` entirely — read-only files, no Composio, no host scripts
   - If unsure → ask. Never assume trust level.

   Optionally add directory mounts to `containerConfig` (see [Advanced: Directory Mounts](#advanced-directory-mounts) below).
3. The group folder is created automatically under `/workspace/group/`
4. Optionally create an initial `CLAUDE.md` for the group
5. **Verify registration**: Read `/workspace/ipc/available_groups.json` and confirm the new entry appears with the correct JID, name, and folder

> ⚠️ **Known bug**: `register_group` only writes to the SQLite DB; the spawn system reads trust level from `available_groups.json`. These are out of sync.
> **Workaround**: After calling `register_group`, manually add the JID-keyed entry to `/workspace/ipc/available_groups.json` with the appropriate `"containerConfig"` (e.g. `{"trusted": true}`). This file is the authoritative source for the spawner.

Folder naming convention — channel prefix + underscore + lowercase hyphenated name:
- WhatsApp "Family Chat" → `whatsapp_family-chat`
- Telegram "Dev Team" → `telegram_dev-team`
- Slack "Engineering" → `slack_engineering`

## Removing a Group

1. Read `/workspace/ipc/available_groups.json`
2. Remove the entry for that group
3. Write the updated JSON back
4. **Verify removal**: Re-read `/workspace/ipc/available_groups.json` and confirm the entry no longer appears
5. The group folder and its files remain (don't delete them)

## Listing Groups

Read `/workspace/ipc/available_groups.json` and format the registered JID-keyed entries nicely for the user.

---

## Advanced: Sender Allowlist

After registering a group, consider configuring a sender allowlist to control who can interact with the assistant. Edit `~/.config/nanoclaw/sender-allowlist.json` on the host:

```json
{
  "default": { "allow": "*", "mode": "trigger" },
  "chats": {
    "<chat-jid>": { "allow": ["sender-id-1", "sender-id-2"], "mode": "trigger" }
  },
  "logDenied": true
}
```

Modes:
- **`trigger`** (default): Stores all messages for context, but only allowed senders can trigger the assistant
- **`drop`**: Messages from non-allowed senders are not stored at all

Notes:
- Your own messages (`is_from_me`) bypass the allowlist in trigger checks
- If the config file doesn't exist or is invalid, all senders are allowed (fail-open)

## Advanced: Directory Mounts

Groups can have extra directories mounted. Add `containerConfig` to the `register_group` call or directly to the group's entry in `/workspace/ipc/available_groups.json`:

```json
{
  "1234567890@g.us": {
    "name": "Dev Team",
    "folder": "telegram_dev-team",
    "trigger": "@Andy",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "trusted": true,
      "additionalMounts": [
        { "hostPath": "~/projects/webapp", "containerPath": "webapp", "readonly": false }
      ]
    }
  }
}
```

The directory will appear at `/workspace/extra/webapp` in that group's container.
