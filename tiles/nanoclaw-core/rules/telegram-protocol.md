# Telegram Communication Protocol

Always-on rules for interacting in Telegram chats.

## Acknowledgement

React to **every** user message before responding or starting work — no exceptions. Pick the most fitting emoji:

- `👌` — got it, working on it (default)
- `👍` — acknowledged / done
- `🔥` — on it (urgent)
- `🤔` — thinking / investigating
- `🤝` — done / confirmed
- `👀` — looking into it

**Valid reaction emoji only** (invalid ones silently fall back to 👍):
👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

## Reply threading

**Always reply-thread** when responding to a user message. Use `reply_to` with the message ID from the `<message id="...">` tag. This links your response to the message it answers.

**Standalone (no reply_to)** only for messages you initiate: scheduled task output, proactive alerts, reminders. These are not responses to anything — they start a new thread.

Rule of thumb: if the user said something and you're answering → `reply_to`. If nobody asked and you're telling → standalone.

## Async pattern

React → work → deliver result. Do NOT hold the user hostage with a reply that says "I'm starting now". The reaction IS the acknowledgement.

## Formatting

Messages are parsed as HTML. Use these tags:

| Format | Syntax |
|--------|--------|
| Bold | `<b>text</b>` |
| Italic | `<i>text</i>` |
| Underline | `<u>text</u>` |
| Strikethrough | `<s>text</s>` |
| Inline code | `<code>text</code>` |
| Code block | `<pre>code</pre>` |
| Code block (lang) | `<pre><code class="language-python">code</code></pre>` |
| Link | `<a href="url">text</a>` |
| Quote | `<blockquote>text</blockquote>` |
| Spoiler | `<tg-spoiler>text</tg-spoiler>` |

**Do NOT use Markdown** (`*bold*`, `_italic_`, `**bold**`, `[link](url)`). It will render as literal text. HTML only.

For bullets use `•` (not `-` or `*`). For emphasis in lists, combine: `• <b>Item</b> — description`.

Special characters `<`, `>`, `&` in user data must be escaped as `&lt;`, `&gt;`, `&amp;`.
