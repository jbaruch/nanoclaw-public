## Query Size Limits

A single tool result should never exceed 25 KB of text. Large results waste context
budget that should go to reasoning and conversation.

When querying `messages.db` or reading files:

- Always use `LIMIT` — max 50 rows for messages, 20 for other tables
- Pipe large command output through `head -100`
- If you need more data, query in batches with `OFFSET`

When reading files:

- Use the `offset` and `limit` parameters on the Read tool for large files
- Don't `cat` entire files into Bash output — use Read with a range instead

If a tool result is unexpectedly large, summarize the relevant portion and discard the rest
rather than keeping it all in context.
