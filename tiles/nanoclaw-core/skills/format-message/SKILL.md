---
name: format-message
description: Look up the correct message formatting syntax for the current channel. Use before sending any formatted response — covers WhatsApp, Telegram, Slack, and Discord syntax rules. Triggers on "how do I format", "what syntax", or whenever you need to check bold/italic/link/bullet rules for the target channel.
---

# Format Message

Check the group folder name prefix to determine the channel, then use the correct syntax below.

## Slack channels (folder starts with `slack_`)

Use Slack mrkdwn syntax:
- `*bold*` (single asterisks)
- `_italic_` (underscores)
- `~strikethrough~`
- `<https://url|link text>` for links (NOT `[text](url)`)
- `•` bullets (no numbered lists)
- `:emoji:` shortcodes like `:white_check_mark:`, `:rocket:`
- `>` for block quotes
- `` `inline code` `` and ` ```code block``` `
- No `##` headings — use `*Bold text*` instead

## WhatsApp/Telegram (folder starts with `whatsapp_` or `telegram_`)

- `*bold*` (single asterisks, NEVER **double**)
- `_italic_` (underscores)
- `~strikethrough~`
- `•` bullet points
- `` `inline code` `` and ` ```code block``` `

No `##` headings. No `[links](url)`. No `**double stars**`. URLs are sent as plain text — they auto-preview.

## Discord (folder starts with `discord_`)

Standard Markdown works:
- `**bold**` (double asterisks)
- `*italic*` (single asterisks)
- `~~strikethrough~~`
- `[link text](url)` for links
- `# heading`, `## subheading`
- `>` block quotes
- `` `inline code` `` and ` ```language\ncode block``` `

## Common mistakes to avoid

- Using `**double asterisks**` in WhatsApp/Telegram/Slack (use single `*`)
- Using `[text](url)` links in Slack (use `<url|text>`)
- Using `##` headings in any channel except Discord
- Using Markdown links in WhatsApp/Telegram (just paste the URL)
