/**
 * markdown-to-html — pure helper for the `no-markdown-in-send-message`
 * PreToolUse hook (#138).
 *
 * Telegram (and the rest of the channels routed through `send_message`)
 * renders **HTML only**. The model leaks Markdown — `**bold**`,
 * `[label](url)`, `` `code` ``, `- bullet` lines — especially under
 * load or after compaction, and the user sees raw asterisks/brackets.
 * The hook auto-rewrites to the HTML equivalent rather than denying:
 * a deny just makes the model re-emit the same tokens and waste a
 * turn.
 *
 * Scope intentionally narrow: only the four patterns called out in
 * the issue. Headings, tables, blockquotes, etc. are out of scope —
 * the agent doesn't typically emit them, and a wider net produces
 * false positives that mangle legitimate text containing `*` or
 * backticks (gh / git output, code review excerpts).
 *
 * Code-block awareness: text inside ``` ``` fences or inline `<pre>`/
 * `<code>` tags is passed through bytewise. The model is allowed to
 * send literal Markdown samples inside a code block — that's how
 * troubleshooting answers quote tool output back at the user.
 *
 * Kept SDK-free so the root vitest can exercise it without spinning
 * up `@anthropic-ai/claude-agent-sdk`.
 */

export interface MarkdownRewriteStats {
  bold: number;
  links: number;
  codeSpans: number;
  bulletLines: number;
}

export interface MarkdownRewriteResult {
  /** The rewritten text with Markdown patterns converted to HTML. */
  out: string;
  /** Per-pattern hit counts; useful for hook logging + tests. */
  stats: MarkdownRewriteStats;
  /** True iff `out !== input` — caller uses this to skip a no-op rewrite. */
  changed: boolean;
}

const EMPTY_STATS: MarkdownRewriteStats = {
  bold: 0,
  links: 0,
  codeSpans: 0,
  bulletLines: 0,
};

/**
 * Split text into runs that are inside a "no-touch" region (fenced or
 * tagged code) and runs that are outside. Markdown rewriting only
 * applies to the outside runs.
 *
 * Recognises:
 *  - Triple-backtick fences (```...```), single-line or multi-line
 *  - <pre>...</pre> blocks (case-insensitive)
 *  - <code>...</code> blocks (case-insensitive)
 *
 * Pre-existing HTML elsewhere is left alone. The model occasionally
 * mixes bare HTML and Markdown in the same message; we don't try to
 * untangle.
 */
function splitCodeRegions(text: string): { content: string; protect: boolean }[] {
  const segments: { content: string; protect: boolean }[] = [];
  // Match the smallest opening of any protected region, then find its
  // close. The order of `|` arms is significant: triple backticks must
  // be tested before single-backtick handling (the rewrite path sees
  // single backticks via the `codeSpan` regex).
  const OPENERS_RE = /```|<pre\b[^>]*>|<code\b[^>]*>/gi;
  let cursor = 0;
  while (cursor < text.length) {
    OPENERS_RE.lastIndex = cursor;
    const match = OPENERS_RE.exec(text);
    if (!match) {
      segments.push({ content: text.slice(cursor), protect: false });
      break;
    }
    if (match.index > cursor) {
      segments.push({ content: text.slice(cursor, match.index), protect: false });
    }
    const opener = match[0];
    const closeRe: RegExp =
      opener === '```'
        ? /```/g
        : /^<pre\b/i.test(opener)
          ? /<\/pre\s*>/gi
          : /<\/code\s*>/gi;
    const afterOpener = match.index + opener.length;
    closeRe.lastIndex = afterOpener;
    const closeMatch = closeRe.exec(text);
    const endIndex = closeMatch
      ? closeMatch.index + closeMatch[0].length
      : text.length;
    segments.push({
      content: text.slice(match.index, endIndex),
      protect: true,
    });
    cursor = endIndex;
  }
  return segments;
}

/**
 * Rewrite Markdown patterns to HTML inside a single non-code segment.
 *
 * Applied in order so pre-rewrites don't interfere:
 *  1. Bullet lines (`- item` / `* item` at line start) → `• item`
 *     (Telegram has no bullet tag; bullet character renders fine
 *     inside a normal text block.)
 *  2. Links `[label](url)` → `<a href="url">label</a>` (URL is HTML-
 *     entity-escaped; label keeps its inline content).
 *  3. Bold `**...**` → `<b>...</b>`.
 *  4. Code spans `` `...` `` → `<code>...</code>` (inner content
 *     entity-escaped so embedded `<`/`&` render literally).
 */
function rewriteSegment(
  text: string,
): { out: string; stats: MarkdownRewriteStats } {
  const stats: MarkdownRewriteStats = { ...EMPTY_STATS };
  let out = text;

  // 1. Bullet lines. Match a `-` or `*` followed by a single space at
  // the start of a line. Avoid matching `*` inside an in-progress
  // `**bold**` opener by requiring the next character not to be `*`
  // (the negative lookahead). The bullet character `•` renders cleanly
  // in Telegram body text without any tag.
  out = out.replace(/^([ \t]*)([-*])(?!\*)\s+/gm, (_match, indent: string) => {
    stats.bulletLines += 1;
    return `${indent}• `;
  });

  // 2. Links. Match `[label](url)` with no nested brackets/parens in
  // either half. Skip if the label spans multiple lines. Both the
  // URL (as an attribute) and the label (as inline text) are HTML-
  // entity-escaped — Telegram's HTML parse mode rejects raw `<` `>`
  // `&` inside an `<a>` payload, and an unescaped `<script>`-like
  // fragment in user data could otherwise produce a parse error or
  // smuggle a stray tag.
  out = out.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_match, label: string, url: string) => {
      stats.links += 1;
      return `<a href="${escapeHtmlAttr(url)}">${escapeHtmlInline(label)}</a>`;
    },
  );

  // 3. Bold. Match `**...**` non-greedy, no intervening `**`. Allows
  // multi-word but stays single-line to avoid swallowing whole
  // paragraphs on stray asterisks. Inner content is HTML-entity-
  // escaped so a raw `<` or `&` inside the bold span doesn't break
  // Telegram's HTML parser.
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, (_match, inner: string) => {
    stats.bold += 1;
    return `<b>${escapeHtmlInline(inner)}</b>`;
  });

  // 4. Code spans. Single backtick pairs with non-empty content, no
  // newlines inside. Telegram's <code> tag preserves whitespace and
  // monospaces.
  out = out.replace(/`([^`\n]+)`/g, (_match, inner: string) => {
    stats.codeSpans += 1;
    return `<code>${escapeHtmlInline(inner)}</code>`;
  });

  return { out, stats };
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlInline(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Top-level entry. Caller in `index.ts` invokes this on the
 * `tool_input.text` (or `tool_input.caption`) string and, if
 * `result.changed` is true, hands `out` back via `updatedInput`.
 *
 * Input shape:
 *  - String input: returned through `rewriteSegment` / passed through
 *    when no patterns matched.
 *  - Empty string: passed through as `''`.
 *  - Non-string (undefined, number, object, …): the `tool_input.text`
 *    field is malformed; `out` is set to `''` and `changed: false` so
 *    the caller's `updatedInput: { ..., text: out }` doesn't accidentally
 *    write a non-string-shaped value back into the SDK call.
 */
export function rewriteMarkdownToHtml(text: unknown): MarkdownRewriteResult {
  if (typeof text !== 'string' || text.length === 0) {
    return {
      out: typeof text === 'string' ? text : '',
      stats: { ...EMPTY_STATS },
      changed: false,
    };
  }
  const segments = splitCodeRegions(text);
  const totals: MarkdownRewriteStats = { ...EMPTY_STATS };
  const rewrittenParts: string[] = [];
  for (const segment of segments) {
    if (segment.protect) {
      rewrittenParts.push(segment.content);
      continue;
    }
    const { out, stats } = rewriteSegment(segment.content);
    rewrittenParts.push(out);
    totals.bold += stats.bold;
    totals.links += stats.links;
    totals.codeSpans += stats.codeSpans;
    totals.bulletLines += stats.bulletLines;
  }
  const out = rewrittenParts.join('');
  return {
    out,
    stats: totals,
    changed: out !== text,
  };
}
