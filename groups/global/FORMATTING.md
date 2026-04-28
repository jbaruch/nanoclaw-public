# Channel Formatting

Format messages based on the channel. The group folder name's prefix tells you which channel you're on.

## Slack channels (folder starts with `slack_`)

Slack mrkdwn syntax. Run `/slack-formatting` for the full reference. Key rules:

- `*bold*` (single asterisks)
- `_italic_` (underscores)
- `<https://url|link text>` for links (NOT `[text](url)`)
- `•` bullets (no numbered lists)
- `:emoji:` shortcodes like `:white_check_mark:`, `:rocket:`
- `>` for block quotes
- No `##` headings — use `*Bold text*` instead

## WhatsApp / Telegram (folder starts with `whatsapp_` or `telegram_`)

- `*bold*` (single asterisks, NEVER **double**)
- `_italic_` (underscores)
- `•` bullet points
- ` ``` ` code blocks

No `##` headings. No `[links](url)`. No `**double stars**`.

## Discord (folder starts with `discord_`)

Standard Markdown: `**bold**`, `*italic*`, `[links](url)`, `# headings`.

## Sending side-channel messages

Your final response goes to the chat as the agent's reply. While you're still working, `mcp__nanoclaw__send_message` sends a message immediately — useful for acknowledging a long-running request before starting the work.
