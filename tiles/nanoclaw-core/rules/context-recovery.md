# Context Recovery — Never Lose History

## The Rule

**Never say you've lost context or forgotten a previous conversation without first querying `messages.db`.**

The full message history is always available at `/workspace/store/messages.db`. Context compaction removes it from your active context — but the database still has it. There is no excuse for "I don't remember what we discussed" when the database is a query away.

## Required behavior

Before responding with any variant of:
- "I don't remember this thread"
- "What were we discussing?"
- "I don't have context on this topic"
- Any acknowledgment that prior conversation is unavailable

You **MUST** first run:

```python
import sqlite3
conn = sqlite3.connect('/workspace/store/messages.db')
rows = conn.execute("""
    SELECT id, timestamp, sender_name, content, is_from_me
    FROM messages
    WHERE chat_jid = (SELECT jid FROM chats LIMIT 1)
      AND content LIKE '%KEYWORD%'
    ORDER BY timestamp DESC
    LIMIT 20
""").fetchall()
for r in rows: print(r)
conn.close()
```

Replace `KEYWORD` with a relevant term from what the user is referencing.

## Database schema (quick reference)

```sql
messages(id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
chats(jid, name, last_message_time, channel, is_group)
```

- `is_from_me = 1` — messages from the bot (your own responses)
- `is_from_me = 0` — messages from users
- `sender_name` — display name of the sender
- `content` — full message text

## When to use

- User references something from an earlier session that's not in active context
- User says "you said..." and you don't have it in context
- Any "I don't remember" impulse — check first
- After context compaction (the summary will mention "continued from previous session")

## This is a hard requirement

Claiming lost context without checking the database is a failure mode equivalent to fabrication. The information exists. Retrieve it.
