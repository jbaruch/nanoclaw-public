# NanoClaw Admin Context

These rules apply only to the main channel, which has elevated privileges.

## Elevated Privileges

This is the **main channel**. You can manage groups, schedule tasks for other groups, and access global memory.

## Authentication

Anthropic credentials are managed by the credential proxy — containers never see real API keys. The proxy reads from `.env` and injects at request time.

## Container Mounts

| Container Path | What | Access |
|----------------|------|--------|
| `/workspace/group` | Group folder | read-write |
| `/workspace/global` | Global memory (SOUL.md, CLAUDE.md) | read-write (main only) |
| `/workspace/store` | messages.db | read-only |
| `/workspace/ipc` | IPC messages/tasks | read-write |
| `/home/node/.claude` | Sessions, skills, settings | read-write |

Key paths:
- `/workspace/store/messages.db` — SQLite database (messages, chats, registered_groups, reactions)
- `/workspace/global/CLAUDE.md` — Global memory (writable from main only)

## Scheduling for Other Groups

When scheduling tasks for other groups, use the `target_group_jid` parameter with the group's JID:
- `schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1", target_group_jid: "tg:-100123456")`

The task will run in that group's context with access to their files and memory.
