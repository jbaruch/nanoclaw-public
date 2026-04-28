/**
 * Markdown → Telegram HTML sanitizer, ported from and hardened beyond
 * an internal prototype.
 *
 * Run at Telegram send time so agent discipline stops mattering: if a skill
 * (or a subagent, or a forgetful prompt) produces Markdown, we convert it to
 * Telegram-flavored HTML here. Idempotent — already-valid HTML passes through.
 *
 * Always-protected regions (never rewritten, whether inside a Markdown
 * capture or not):
 *   - Fenced code blocks (```...```) — preserved as <pre> with contents escaped.
 *   - Whole inline HTML element spans (`<code>…</code>`, `<pre>…</pre>`,
 *     `<b>…</b>`, `<i>…</i>`, `<u>…</u>`, `<s>…</s>`, `<a>…</a>`,
 *     `<blockquote>…</blockquote>`, `<tg-spoiler>…</tg-spoiler>`) — the
 *     element AND its contents are protected, so Markdown markers inside
 *     pre-formatted HTML (e.g. `<code>*literal*</code>`) aren't rewritten.
 *   - http / https / ftp URLs, email addresses.
 *
 * Stray tag tokens (self-closing, mismatched, or tags not in
 * Telegram's allowlist — e.g. `<N>`, `<bar>`, `<analysis>`):
 *   - HTML-escaped in the output when they appear in plain prose or
 *     inside a Markdown capture. ONE important exception: content
 *     already protected as an allowlisted HTML span in Phase 1a
 *     (`<code>…</code>`, `<pre>…</pre>`, `<b>…</b>`, and the other
 *     PROTECTED_SPAN_TAGS entries) is restored verbatim in Phase 3,
 *     so stray tags INSIDE such a span survive as-is. That's by
 *     design for the "already-valid HTML passes through" contract —
 *     e.g. `<code><analysis>x</analysis></code>` keeps the inner
 *     `<analysis>` visible as literal code. If the content inside a
 *     protected span contains a tag Telegram rejects, the send will
 *     fall back to raw text for that message (same failure mode as
 *     pre-fix top-level strays); authors of `<code>…</code>`-wrapped
 *     snippets should escape inner angle brackets themselves.
 *   - Earlier behavior let stray tags in plain prose pass through
 *     verbatim, which produced the same failure mode the inside-
 *     capture escaping was designed to prevent: Telegram's HTML
 *     parser rejects any tag not in its allowlist with a 400
 *     "Unsupported start tag" error, which dumps the whole message
 *     into `sendTelegramMessage`'s plain-text fallback (see
 *     src/channels/telegram.ts) — the fallback ships the ORIGINAL
 *     unsanitized text with no `parse_mode`, so the user sees raw
 *     Markdown markers (`_foo_`, `**bar**`) instead of rendered
 *     italics/bold. Escaping stray tags at the top level keeps
 *     HTML-send on the happy path; agents that need literal HTML
 *     should use the supported allowlist intentionally. See
 *     jbaruch/nanoclaw#81 for the production recurrence that forced
 *     this unification.
 *
 * Converted patterns (captured text is HTML-escaped before insertion so
 * characters like `&`, `<`, `>`, `"` in content don't produce invalid entities):
 *   [text](url)      → <a href="url">text</a>
 *   `code`           → <code>code</code>
 *   **bold** / __b__ → <b>bold</b>
 *   *italic* / _i_   → <i>italic</i>  (only when delimiters look like formatting)
 *   # heading        → <b>heading</b> (line-start, 1-6 hashes)
 *   - item / * item  → • item (line-start bullet)
 */

// Two separate placeholder namespaces.
//
// `PH_PREFIX` ("protect and preserve") is used for regions whose content
// must be passed to Telegram verbatim inside the final output — fenced
// code blocks (Phase 0), already-valid HTML element spans (Phase 1a),
// and URLs / email addresses (Phase 1c). These are RESTORED by Phase 3
// and MUST survive through Phase 2 Markdown captures intact, so a
// `**<code>x</code>**` input still ships `<b><code>x</code></b>` with
// the inner span untouched.
//
// `PH_STRAY_PREFIX` ("protect until Phase 2 decides") is used only for
// stray tag tokens (Phase 1b) like `<N>`, `<bar>`, or `<analysis>`.
// Inside a Phase 2 capture (`` ` … ` ``, `**…**`, etc.) the stray
// token is RESOLVED and HTML-escaped via `escapeCaptured`, so the
// captured content ends up like `<code>&lt;N&gt;</code>`. Outside of
// a capture, Phase 3 ALSO HTML-escapes the stray token — the earlier
// behavior (restoring raw) caused `<analysis>` / other
// non-whitelisted tags to reject Telegram's HTML parse and drop the
// send into the raw-text fallback. Both code paths now produce
// escape-safe output for Telegram's HTML allowlist; agents that need
// literal HTML must use the supported tag set.
const PH_PREFIX = '\u0000PH';
const PH_STRAY_PREFIX = '\u0000ST';
const PH_SUFFIX = '\u0000';

/**
 * Escape only the characters Telegram's HTML parser actually decodes in
 * CONTENT regions (text between tags): `&`, `<`, `>`. Used for visible
 * text — link labels, code, bold, italic, heading bodies.
 *
 * Telegram does NOT decode `&apos;` or `&quot;` in content — both
 * render as the literal entity string. So `htmlEscape` would have
 * produced `say &quot;hi&quot;` and the user would see `say
 * &quot;hi&quot;` instead of `say "hi"`. Closes #160's content path.
 */
function htmlEscapeContent(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape for HTML ATTRIBUTE values (currently just `<a href="…">`).
 * Adds `"` → `&quot;` on top of `htmlEscapeContent`. Telegram correctly
 * decodes `&quot;` in attribute values, so this stays.
 */
function htmlEscapeAttr(s: string): string {
  return htmlEscapeContent(s).replace(/"/g, '&quot;');
}

/**
 * Decode entity references that the agent sometimes emits inline
 * (`&apos;`, `&quot;`, numeric `&#39;`, `&#34;`) back to raw chars
 * BEFORE the sanitizer runs. Without this, `Baruch&apos;s Office`
 * passes through unchanged in plain prose (no Markdown captures to
 * trigger htmlEscape) and Telegram renders the literal entity string
 * — see #160 for the production sighting.
 *
 * Deliberately narrow: only the four entities Telegram doesn't decode
 * itself in content. `&amp;`, `&lt;`, `&gt;` stay encoded for two
 * reasons: (1) Telegram decodes them itself when rendering, so the
 * user sees the right characters either way; (2) decoding `&lt;` /
 * `&gt;` here would inject raw `<` / `>` into the pipeline. Phase 1b
 * catches tag-SHAPED tokens (`<word…>`) and escapes them, but
 * non-tag patterns like `<3` or `<-x>` slip past Phase 1b's regex
 * and end up as literal `<` in the output, which Telegram's HTML
 * parser rejects as malformed and falls back to raw-text send.
 * Leaving the three Telegram-decoded entities encoded end-to-end
 * keeps the output well-formed.
 *
 * Ordering: this runs BEFORE Phase 0 so the decoded content reaches
 * the rest of the pipeline as raw chars.
 */
function decodeAgentEntities(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"');
}

/**
 * Inline HTML tags whose full span (opening + contents + closing) must be
 * treated as opaque. Order matters only inside this list for readability.
 */
const PROTECTED_SPAN_TAGS = [
  'pre',
  'code',
  'blockquote',
  'a',
  'b',
  'i',
  'u',
  's',
  'tg-spoiler',
];

export function sanitizeTelegramHtml(text: string): string {
  if (!text) return text;

  // Decode agent-emitted `&apos;` / `&quot;` (and numeric forms) BEFORE
  // any other phase runs. See `decodeAgentEntities` docstring for why
  // this only covers the four entities Telegram doesn't decode itself
  // — touching `&lt;`/`&gt;`/`&amp;` here would smuggle real angle
  // brackets past the stray-tag protector.
  text = decodeAgentEntities(text);

  const placeholders: string[] = [];
  const strayPlaceholders: string[] = [];

  const protect = (match: string): string => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `${PH_PREFIX}${idx}${PH_SUFFIX}`;
  };
  const protectStray = (match: string): string => {
    const idx = strayPlaceholders.length;
    strayPlaceholders.push(match);
    return `${PH_STRAY_PREFIX}${idx}${PH_SUFFIX}`;
  };

  const PH_RE = new RegExp(`${PH_PREFIX}(\\d+)${PH_SUFFIX}`, 'g');
  const PH_STRAY_RE = new RegExp(`${PH_STRAY_PREFIX}(\\d+)${PH_SUFFIX}`, 'g');

  // Phase 2 conversions (`[…](…)`, `` `…` ``, `**…**`, etc.) capture
  // content and wrap it in Telegram HTML tags. That captured content may
  // contain placeholders injected earlier. A plain `htmlEscape` on the
  // captured text sees only the opaque `\u0000…\u0000` markers — no `<`,
  // `>`, `&`, or `"` to escape — so it's a no-op, and Phase 3 restores
  // the raw text INSIDE our freshly-created `<code>`/`<b>`/etc. tag.
  //
  // For stray-tag placeholders this is a bug: Telegram would see a raw
  // `<N>` inside `<code>`, reject the whole message with 400, and
  // `sendTelegramMessage`'s catch would fire the plain-text fallback —
  // which ships the original Markdown verbatim. That's the exact
  // "`**foo**` leaked through the preprocessor" symptom the fix
  // addresses: resolve stray-tag placeholders inside the capture and
  // HTML-escape them, so the output is `<code>&lt;N&gt;</code>`.
  //
  // For protect placeholders (Phase 0/1a/1c — fenced code, already-
  // valid HTML spans, URLs, emails) the old no-op was INTENTIONAL: the
  // "Protected regions (never rewritten)" contract says inputs like
  // `**<code>x</code>**` must preserve the inner `<code>x</code>` span
  // verbatim inside `<b>…</b>`. So only stray placeholders get
  // resolved here; protect ones keep surviving through to Phase 3.
  // Bounds-checked array lookup. When we emit placeholders ourselves
  // via `protect`/`protectStray`, the index is always `arr.length` at
  // emit time, so the round-trip is safe by construction. The range
  // check is defense against INPUTS that happen to contain a NUL-
  // delimited PH/ST-shaped sequence we didn't produce — e.g.
  // adversarial text, or a previous sanitizer output round-tripped
  // through this one. In that case the extracted index can point
  // well past `arr.length` (or be a multi-digit number we never
  // pushed). Returning `match` preserves the literal bytes rather
  // than emitting "undefined".
  const resolveFrom =
    (arr: string[]) =>
    (match: string, idx: string): string => {
      const n = Number(idx);
      return n >= 0 && n < arr.length ? arr[n] : match;
    };

  // Two captured-text escapers: `escapeCapturedContent` for visible
  // text (link labels, code, bold, italic, heading bodies) — does NOT
  // emit `&quot;`. `escapeCapturedAttr` for `<a href="…">` URL values
  // — does emit `&quot;` because attributes need it and Telegram
  // decodes it correctly there.
  const escapeCapturedContent = (s: string): string =>
    htmlEscapeContent(s.replace(PH_STRAY_RE, resolveFrom(strayPlaceholders)));
  const escapeCapturedAttr = (s: string): string =>
    htmlEscapeAttr(s.replace(PH_STRAY_RE, resolveFrom(strayPlaceholders)));

  let out = text;

  // Phase 0: fenced code blocks — stash entire ```…``` regions, rewritten
  // into <pre> with contents HTML-escaped so code samples containing `**`
  // or `_` or `<` aren't mangled downstream.
  out = out.replace(
    /```(?:[\w-]+)?\r?\n([\s\S]*?)\r?\n```/g,
    (_m, code: string) => protect(`<pre>${htmlEscapeContent(code)}</pre>`),
  );
  // Single-line / unterminated fenced blocks (defensive — less common).
  out = out.replace(/```([\s\S]*?)```/g, (_m, code: string) =>
    protect(`<pre>${htmlEscapeContent(code)}</pre>`),
  );

  // Phase 1a: protect full HTML element spans (tag + contents + closing tag)
  // so Markdown markers inside already-formatted HTML remain literal.
  // Non-greedy; does not attempt to handle nesting of the same tag.
  for (const tag of PROTECTED_SPAN_TAGS) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi');
    out = out.replace(re, protect);
  }

  // Phase 1b: protect stray tag tokens (self-closing, mismatched, or tags
  // we don't recognise as span-ful). Uses `protectStray` so a token that
  // ends up inside a Phase 2 capture gets resolved+escaped there
  // (`escapeCaptured`) instead of restored raw in Phase 3 — otherwise
  // Telegram rejects the unknown tag and the send falls back to plain
  // text.
  out = out.replace(
    /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\s*\/?>/g,
    protectStray,
  );

  // Phase 1c: protect URLs and email addresses so their underscores/dots
  // don't get mistaken for Markdown formatting.
  out = out.replace(/https?:\/\/[^\s<>")\]]+/g, protect);
  out = out.replace(/ftp:\/\/[^\s<>")\]]+/g, protect);
  out = out.replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+/g, protect);

  // Phase 2: Markdown → HTML. Captured groups run through `escapeCaptured`
  // (resolve placeholders, then HTML-escape) so `**a & b**` → `<b>a &amp;
  // b</b>` and `` `<N>` `` → `<code>&lt;N&gt;</code>` — no raw `&` or
  // stray tag tokens end up inside our freshly-created Telegram tags.
  //
  // 2a. Links — url may be a placeholder from Phase 1c (protected URL),
  // or a mix of protected URL prefix + stray-tag suffix when the href
  // contains `<`/`>` that broke Phase 1c's URL regex.
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, txt: string, url: string) =>
      `<a href="${escapeCapturedAttr(url)}">${escapeCapturedContent(txt)}</a>`,
  );

  // 2b. Inline code — before bold/italic so backticked content isn't mangled.
  out = out.replace(
    /`([^`\n]+)`/g,
    (_m, code: string) => `<code>${escapeCapturedContent(code)}</code>`,
  );

  // 2c. Bold: **x** or __x__
  out = out.replace(
    /\*\*(.+?)\*\*/g,
    (_m, t: string) => `<b>${escapeCapturedContent(t)}</b>`,
  );
  out = out.replace(
    /__(.+?)__/g,
    (_m, t: string) => `<b>${escapeCapturedContent(t)}</b>`,
  );

  // 2d. Italic: *x* or _x_ — must look like formatting, not identifier parts.
  out = out.replace(
    /(^|[^\w])\*(\S(?:.*?\S)?)\*(?!\w)/g,
    (_m, pre: string, t: string) => `${pre}<i>${escapeCapturedContent(t)}</i>`,
  );
  out = out.replace(
    /(^|[^\w])_(\S(?:.*?\S)?)_(?!\w)/g,
    (_m, pre: string, t: string) => `${pre}<i>${escapeCapturedContent(t)}</i>`,
  );

  // 2e. Headings: # to ###### at line start → <b>…</b>
  out = out.replace(
    /^#{1,6}\s+(.+)$/gm,
    (_m, t: string) => `<b>${escapeCapturedContent(t)}</b>`,
  );

  // 2f. Bullets: - item / * item at line start → • item
  out = out.replace(/^[-*]\s+/gm, '\u2022 ');

  // Phase 3: restore any placeholders still in the text — these are
  // the ones that were NOT inside a Phase 2 capture. Bounds-checked so
  // a crafted `\u0000PH<big>\u0000` token in the input doesn't emit
  // "undefined".
  //
  // Protect placeholders (Phase 0/1a/1c — fenced code, already-valid
  // span HTML, URLs, emails) restore VERBATIM: these are intentionally
  // opaque regions and their contents are already valid Telegram HTML
  // (or deliberately pass-through, like a URL).
  //
  // Stray placeholders (Phase 1b — tokens like `<analysis>`, `<bar>`,
  // `<N>` that we couldn't fold into a protected span) get
  // HTML-ESCAPED here rather than restored raw. Telegram's HTML parser
  // rejects any tag not in its narrow allowlist (b/i/u/s/code/pre/
  // blockquote/a/tg-spoiler) and fails the entire message with a 400
  // "Unsupported start tag" error. That 400 drops
  // `sendTelegramMessage` into its plain-text fallback, which ships
  // the ORIGINAL unsanitized text with no parse mode — so the user
  // sees raw Markdown (`_foo_`, `**bar**`) instead of the rendered
  // italic/bold the sanitizer was about to produce. Escaping stray
  // tags keeps HTML valid: the user sees literal `<analysis>` text,
  // but Markdown formatting elsewhere in the message renders
  // correctly. Root cause of jbaruch/nanoclaw#81's 2026-04-19
  // recurrence — heartbeat emitted Claude-reasoning wrappers
  // (`<analysis>`) at the top of its reply text.
  out = out.replace(PH_RE, resolveFrom(placeholders));
  out = out.replace(PH_STRAY_RE, (_m, idx: string): string => {
    const n = Number(idx);
    return n >= 0 && n < strayPlaceholders.length
      ? htmlEscapeContent(strayPlaceholders[n])
      : _m;
  });

  return out;
}
