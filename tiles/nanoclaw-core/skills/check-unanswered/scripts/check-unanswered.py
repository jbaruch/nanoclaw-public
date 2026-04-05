#!/usr/bin/env python3
"""
Deterministic unanswered message detector.

A user message is "answered" if a bot message exists with
reply_to_message_id pointing to it. No reply_to = not an answer,
just another message. Simple, precise, no time-window heuristics.

Outputs JSON to stdout. Empty list = nothing to report.
"""

import sqlite3
import json
import sys
import os
from datetime import datetime, timedelta, timezone

DB = os.environ.get('NANOCLAW_DB', '/workspace/store/messages.db')
CHAT_JID = os.environ.get('NANOCLAW_CHAT_JID', '')
LOOKBACK_HOURS = int(os.environ.get('LOOKBACK_HOURS', '24'))

if not CHAT_JID:
    try:
        conn = sqlite3.connect(DB, timeout=5)
        row = conn.execute(
            "SELECT chat_jid FROM messages WHERE is_from_me=1 ORDER BY timestamp DESC LIMIT 1"
        ).fetchone()
        conn.close()
        if row:
            CHAT_JID = row[0]
        else:
            print(json.dumps({"unanswered": [], "error": "no bot messages found"}))
            sys.exit(0)
    except Exception as e:
        print(json.dumps({"unanswered": [], "error": str(e)}))
        sys.exit(0)

try:
    conn = sqlite3.connect(DB, timeout=5)
except sqlite3.OperationalError as e:
    print(json.dumps({"unanswered": [], "error": f"DB open failed: {e}"}))
    sys.exit(0)

cutoff = (datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)).strftime('%Y-%m-%dT%H:%M:%S')

# Find user messages that have no bot reply threading to them.
# A bot message "answers" a user message when reply_to_message_id = user_msg.id
unanswered = conn.execute("""
    SELECT m.id, m.sender_name, m.content, m.timestamp
    FROM messages m
    WHERE m.chat_jid = ?
      AND m.is_from_me = 0
      AND m.is_bot_message = 0
      AND m.timestamp > ?
      AND NOT EXISTS (
        SELECT 1 FROM messages r
        WHERE r.chat_jid = m.chat_jid
          AND r.is_from_me = 1
          AND r.reply_to_message_id = m.id
      )
    ORDER BY m.timestamp ASC
""", (CHAT_JID, cutoff)).fetchall()

conn.close()

results = [
    {"id": msg_id, "sender_name": sender, "content": content, "timestamp": ts}
    for msg_id, sender, content, ts in unanswered
]

print(json.dumps({
    "unanswered": results,
    "chat_jid": CHAT_JID,
    "lookback_hours": LOOKBACK_HOURS,
    "checked_at": datetime.now(timezone.utc).isoformat()
}))
