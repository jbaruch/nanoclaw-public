import { describe, it, expect } from 'vitest';
import { sanitizeTelegramHtml } from './telegram-sanitize.js';

describe('sanitizeTelegramHtml — Markdown → HTML', () => {
  it('converts **bold** to <b>', () => {
    expect(sanitizeTelegramHtml('say **this** now')).toBe(
      'say <b>this</b> now',
    );
  });

  it('converts __bold__ to <b>', () => {
    expect(sanitizeTelegramHtml('__emphasis__')).toBe('<b>emphasis</b>');
  });

  it('converts *italic* to <i>', () => {
    expect(sanitizeTelegramHtml('feeling *great* today')).toBe(
      'feeling <i>great</i> today',
    );
  });

  it('converts _italic_ to <i>', () => {
    expect(sanitizeTelegramHtml('feeling _great_ today')).toBe(
      'feeling <i>great</i> today',
    );
  });

  it('converts `code` to <code>', () => {
    expect(sanitizeTelegramHtml('run `npm test`')).toBe(
      'run <code>npm test</code>',
    );
  });

  it('converts [text](url) to <a href>', () => {
    expect(sanitizeTelegramHtml('[Docs](https://example.com)')).toBe(
      '<a href="https://example.com">Docs</a>',
    );
  });

  it('converts # headings to <b>', () => {
    expect(sanitizeTelegramHtml('# Top\n## Sub\n### Detail')).toBe(
      '<b>Top</b>\n<b>Sub</b>\n<b>Detail</b>',
    );
  });

  it('converts - and * bullets to •', () => {
    expect(sanitizeTelegramHtml('- one\n* two\n- three')).toBe(
      '\u2022 one\n\u2022 two\n\u2022 three',
    );
  });

  it('handles mixed content in one pass', () => {
    const input = '**Bug fix**: see [ticket](https://jira.example.com/T-1) now';
    expect(sanitizeTelegramHtml(input)).toBe(
      '<b>Bug fix</b>: see <a href="https://jira.example.com/T-1">ticket</a> now',
    );
  });
});

describe('sanitizeTelegramHtml — idempotence (pre-formatted HTML)', () => {
  it('passes well-formed HTML through unchanged', () => {
    const html = '<b>bold</b> and <i>italic</i> with <code>code</code>';
    expect(sanitizeTelegramHtml(html)).toBe(html);
  });

  it('is idempotent — running twice produces the same result', () => {
    const input = '**bold** and *italic* and [link](https://a.com)';
    const once = sanitizeTelegramHtml(input);
    expect(sanitizeTelegramHtml(once)).toBe(once);
  });

  it('preserves <a href> tags even when text contains underscores', () => {
    const input = '<a href="https://a.com/path_with_underscores">click</a>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });
});

describe('sanitizeTelegramHtml — protected regions', () => {
  it('does not transform underscores inside URLs', () => {
    const input = 'see https://example.com/path_with_underscores for details';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('does not transform underscores inside email addresses', () => {
    const input = 'contact foo_bar@example.com please';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('preserves ftp URLs', () => {
    const input = 'archive at ftp://files.example.com/path_name';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('inline code blocks with * characters are not mangled', () => {
    expect(sanitizeTelegramHtml('use `a*b*c` as the pattern')).toBe(
      'use <code>a*b*c</code> as the pattern',
    );
  });
});

describe('sanitizeTelegramHtml — edge cases', () => {
  it('empty input returns empty', () => {
    expect(sanitizeTelegramHtml('')).toBe('');
  });

  it('text with no Markdown passes through unchanged', () => {
    expect(sanitizeTelegramHtml('plain text here')).toBe('plain text here');
  });

  it('lone asterisk is not treated as italic', () => {
    expect(sanitizeTelegramHtml('use a * b for multiply')).toBe(
      'use a * b for multiply',
    );
  });

  it('snake_case_identifier is not treated as italic', () => {
    expect(sanitizeTelegramHtml('call my_func_name please')).toBe(
      'call my_func_name please',
    );
  });

  it('handles multi-line mixed input', () => {
    const input = '# Release\n- **feat**: added X\n- _fix_: Y';
    expect(sanitizeTelegramHtml(input)).toBe(
      '<b>Release</b>\n\u2022 <b>feat</b>: added X\n\u2022 <i>fix</i>: Y',
    );
  });
});

// --- HTML entity safety: captured text must be escaped before insertion ---
describe('sanitizeTelegramHtml — HTML entity escaping', () => {
  it('escapes & inside **bold** so Telegram does not reject the entity', () => {
    expect(sanitizeTelegramHtml('**Jack & Jill**')).toBe(
      '<b>Jack &amp; Jill</b>',
    );
  });

  it('escapes comparison operators inside *italic* captured text', () => {
    // Using `>` that isn't part of a tag pattern (no `<…>`) so it stays as
    // content that Phase 2 captures and escapes.
    expect(sanitizeTelegramHtml('say *5 > 3 && 1 < 2* today')).toBe(
      'say <i>5 &gt; 3 &amp;&amp; 1 &lt; 2</i> today',
    );
  });

  it('escapes quotes and special chars in link text', () => {
    expect(sanitizeTelegramHtml('[Jack & Jill](https://example.com/a)')).toBe(
      '<a href="https://example.com/a">Jack &amp; Jill</a>',
    );
  });

  it('escapes & inside inline code', () => {
    expect(sanitizeTelegramHtml('run `x && y` now')).toBe(
      'run <code>x &amp;&amp; y</code> now',
    );
  });

  it('escapes < > & in headings', () => {
    expect(sanitizeTelegramHtml('# Release < v2 & later')).toBe(
      '<b>Release &lt; v2 &amp; later</b>',
    );
  });

  // --- Regression tests for the "stray tag token inside Markdown capture"
  // bug. Phase 1b protects `<N>`-shaped tokens as placeholders BEFORE
  // Phase 2 runs, so a naïve `htmlEscape` on captured Markdown content
  // only saw the opaque placeholder and restored the raw `<N>` inside
  // the freshly-created Telegram tag. Telegram's HTML parser only
  // accepts a fixed whitelist, so it would reject the whole message and
  // `sendTelegramMessage` would fire its raw-text fallback — shipping
  // literal Markdown the preprocessor was supposed to convert. Observed
  // on `2026-04-19` when Andy referenced `` `*/skills/<N>` `` and
  // `` `tessl__<N>` `` in a Russian summary of the promote pipeline.
  //
  // Each case below was previously broken (produced `<code><N></code>`,
  // `<b>**<N>**`-ish, etc.); the fix resolves placeholders before
  // escaping inside every Phase 2 capture.

  it('inline `<N>` inside backticks is escaped, not passed through as a stray tag', () => {
    expect(sanitizeTelegramHtml('a `<N>` b')).toBe(
      'a <code>&lt;N&gt;</code> b',
    );
  });

  it('backtick code with multi-char tag-like token inside', () => {
    expect(sanitizeTelegramHtml('use `foo<bar>baz` as key')).toBe(
      'use <code>foo&lt;bar&gt;baz</code> as key',
    );
  });

  it('path-like backtick content with angle-bracket placeholder', () => {
    expect(sanitizeTelegramHtml('find `*/skills/<N>` entries')).toBe(
      'find <code>*/skills/&lt;N&gt;</code> entries',
    );
  });

  it('stray tag token inside **bold** is escaped', () => {
    expect(sanitizeTelegramHtml('**use <N> here**')).toBe(
      '<b>use &lt;N&gt; here</b>',
    );
  });

  it('stray tag token inside *italic* is escaped', () => {
    expect(sanitizeTelegramHtml('see *the <N> variable* below')).toBe(
      'see <i>the &lt;N&gt; variable</i> below',
    );
  });

  it('stray tag token inside [link text](url) is escaped', () => {
    expect(sanitizeTelegramHtml('[see <N> docs](https://example.com/n)')).toBe(
      '<a href="https://example.com/n">see &lt;N&gt; docs</a>',
    );
  });

  it('stray tag token inside # heading is escaped', () => {
    expect(sanitizeTelegramHtml('# About <N> placeholders')).toBe(
      '<b>About &lt;N&gt; placeholders</b>',
    );
  });

  // --- Contract from the header doc: "Protected regions (never
  // rewritten)" — if the stray-tag-escape logic ever starts resolving
  // Phase 0/1a/1c placeholders too, these regress. An existing
  // `<code>…</code>`, `<pre>…</pre>`, URL, or email inside a Markdown
  // capture must survive to the output verbatim, NOT get
  // double-escaped.

  it('protected `<code>x</code>` inside **bold** is preserved, not double-escaped', () => {
    expect(sanitizeTelegramHtml('**pre: <code>x</code> done**')).toBe(
      '<b>pre: <code>x</code> done</b>',
    );
  });

  it('protected `<pre>…</pre>` inside *italic* is preserved', () => {
    expect(sanitizeTelegramHtml('look at *<pre>code</pre>* carefully')).toBe(
      'look at <i><pre>code</pre></i> carefully',
    );
  });

  it('URL inside **bold** is restored, not escaped', () => {
    expect(sanitizeTelegramHtml('**visit https://example.com now**')).toBe(
      '<b>visit https://example.com now</b>',
    );
  });

  // --- Paranoia: if input text ever contains a NUL-delimited
  // placeholder-shaped sequence that didn't come from `protect` /
  // `protectStray`, the index could point past the end of the
  // placeholders array. The bounds-checked `resolveFrom` leaves the
  // literal text as-is instead of emitting "undefined".

  it('stray-style placeholder sequence in raw input with out-of-range index is left literal', () => {
    const input = 'normal text \u0000ST42\u0000 more text';
    // Expect the literal placeholder-shaped bytes to survive — better than
    // crashing or emitting "undefined". Inside our own processing the
    // indices come from `strayPlaceholders.length`, so 42 will never
    // match a real entry.
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('protect-style placeholder sequence in raw input with out-of-range index is left literal', () => {
    const input = 'some \u0000PH99\u0000 thing';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  // --- Regression for jbaruch/nanoclaw#81 (2026-04-19 recurrence):
  // heartbeat's Claude-SDK reply started with `<analysis>` (a reasoning
  // artifact, not in Telegram's HTML allowlist). Old behaviour: Phase 1b
  // stashed it as a stray placeholder and Phase 3 restored the literal
  // `<analysis>` tag, which Telegram rejected with 400 "Unsupported
  // start tag". `sendTelegramMessage` then fell back to sending the raw
  // unsanitized text, so the user saw `<analysis>` AND raw Markdown
  // formatting markers. New behaviour: Phase 3 HTML-escapes stray tags
  // so the full message remains valid Telegram HTML and Markdown
  // elsewhere in the text (`_foo_` → `<i>foo</i>`) still renders.

  it('top-level <analysis> tag outside any Markdown capture is escaped, not preserved raw', () => {
    expect(sanitizeTelegramHtml('<analysis>reasoning</analysis>')).toBe(
      '&lt;analysis&gt;reasoning&lt;/analysis&gt;',
    );
  });

  it('top-level stray tag with Markdown elsewhere: tag is escaped, Markdown is converted', () => {
    expect(
      sanitizeTelegramHtml('<analysis>hi</analysis>\n_Email alert_ here'),
    ).toBe('&lt;analysis&gt;hi&lt;/analysis&gt;\n<i>Email alert</i> here');
  });

  it('stray tag at byte 0 (exact shape of the production failure) is escaped', () => {
    const input =
      '<analysis>\nCycle 34 precheck at 18:40:00Z.\n- Step 2: Skipped\n';
    const out = sanitizeTelegramHtml(input);
    expect(out.startsWith('&lt;analysis&gt;')).toBe(true);
    expect(out.includes('• Step 2: Skipped')).toBe(true);
  });
});

// --- Existing HTML element spans: contents must be preserved verbatim ---
describe('sanitizeTelegramHtml — whole HTML spans protected', () => {
  it('<code>*literal*</code> — Markdown inside code is not rewritten', () => {
    const input = 'pattern: <code>*literal*</code>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('<pre>__init__</pre> — Python dunder survives intact', () => {
    const input = 'see <pre>__init__</pre>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('<b>**already bold**</b> — inner markers are not double-processed', () => {
    const input = '<b>**already bold**</b>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('<a href="...">text_with_underscores</a> — link text underscores preserved', () => {
    const input = '<a href="https://example.com">foo_bar_baz</a>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });

  it('<blockquote>*italic inside quote*</blockquote> — quote contents preserved', () => {
    const input = '<blockquote>*keep as-is*</blockquote>';
    expect(sanitizeTelegramHtml(input)).toBe(input);
  });
});

// --- Fenced code blocks must never be rewritten ---
describe('sanitizeTelegramHtml — fenced code blocks', () => {
  it('triple-backtick block is wrapped in <pre> with contents escaped', () => {
    const input = '```\n**not bold**\n__init__\n```';
    expect(sanitizeTelegramHtml(input)).toBe(
      '<pre>**not bold**\n__init__</pre>',
    );
  });

  it('fenced block with language hint is preserved', () => {
    // `"` stays raw — Telegram doesn't decode `&quot;` in <pre> content,
    // so emitting it would render the literal entity. `<` and `&` still
    // need the standard escapes Telegram supports. See issue #160.
    const input = '```python\nif x < 5:\n    print("a & b")\n```';
    expect(sanitizeTelegramHtml(input)).toBe(
      '<pre>if x &lt; 5:\n    print("a &amp; b")</pre>',
    );
  });

  it('Markdown outside fenced block is still processed', () => {
    const input = '**bold** before\n```\n**raw**\n```\n**bold** after';
    expect(sanitizeTelegramHtml(input)).toBe(
      '<b>bold</b> before\n<pre>**raw**</pre>\n<b>bold</b> after',
    );
  });
});

// --- Defensive: the `*bold*` that the old parseTextStyles used to emit
//     is no longer reached now that telegram is passthrough. Pinned here
//     as the definition of current behavior: lone `*foo*` is italic,
//     NOT bold. If you ever reintroduce WhatsApp-style markers in
//     parseTextStyles, this test tells you what breaks.
describe('sanitizeTelegramHtml — contract with parseTextStyles', () => {
  it('lone *foo* is italic (would be wrong if parseTextStyles emitted *bold*)', () => {
    expect(sanitizeTelegramHtml('say *foo* now')).toBe('say <i>foo</i> now');
  });
});

// --- Issue #160: Telegram doesn't decode `&apos;` or `&quot;` in content ---

describe('sanitizeTelegramHtml — agent-emitted entities (issue #160)', () => {
  it('decodes &apos; from plain prose into a raw apostrophe', () => {
    // Production sighting: agent wrote "Baruch&apos;s Office" and
    // Telegram rendered the literal entity. Sanitizer must turn it
    // into a raw apostrophe so the user sees "Baruch's Office".
    expect(sanitizeTelegramHtml('Baruch&apos;s Office')).toBe(
      "Baruch's Office",
    );
  });

  it('decodes &quot; from plain prose into a raw quote', () => {
    expect(sanitizeTelegramHtml('they said &quot;hi&quot;')).toBe(
      'they said "hi"',
    );
  });

  it('decodes numeric &#39; and &#34; forms', () => {
    expect(sanitizeTelegramHtml('Baruch&#39;s &#34;office&#34;')).toBe(
      'Baruch\'s "office"',
    );
  });

  it('decodes agent entities INSIDE a Markdown bold capture', () => {
    // The decode runs before Phase 2 captures, so a `**Baruch&apos;s**`
    // input becomes `**Baruch's**` first, then the bold conversion
    // produces a clean `<b>Baruch's</b>` instead of `<b>Baruch&amp;apos;s</b>`.
    expect(sanitizeTelegramHtml('**Baruch&apos;s rules**')).toBe(
      "<b>Baruch's rules</b>",
    );
  });

  it('does NOT decode &amp; (Telegram decodes it itself)', () => {
    // Decoding `&amp;` here would leak a raw `&` into prose, which
    // Telegram then mis-parses if it appears next to other entity-like
    // sequences. Safer to leave the three Telegram-supported entities
    // alone end-to-end.
    expect(sanitizeTelegramHtml('a &amp; b')).toBe('a &amp; b');
  });

  it('does NOT decode &lt; / &gt; (would smuggle real angle brackets)', () => {
    // Decoding `&lt;` to `<` here would let the agent inject what
    // looks like a stray tag past Phase 1b's stray-tag protector.
    // The three Telegram-decoded entities stay encoded throughout.
    expect(sanitizeTelegramHtml('a &lt;tag&gt; b')).toBe('a &lt;tag&gt; b');
  });
});

// --- Issue #160: " in content stays raw, but stays escaped in href attributes ---

describe('sanitizeTelegramHtml — quote handling in content vs attributes', () => {
  it('leaves " raw in <code> content (Telegram does NOT decode &quot; in content)', () => {
    expect(sanitizeTelegramHtml('`say "hi"`')).toBe('<code>say "hi"</code>');
  });

  it('leaves " raw in <b> content', () => {
    expect(sanitizeTelegramHtml('**say "hi"**')).toBe('<b>say "hi"</b>');
  });

  it('leaves " raw in <i> content', () => {
    expect(sanitizeTelegramHtml('*say "hi"*')).toBe('<i>say "hi"</i>');
  });

  it('still escapes " to &quot; inside href attribute values', () => {
    // Telegram decodes `&quot;` correctly in attribute values, and
    // raw `"` inside `href="…"` would close the attribute prematurely.
    // So content gets raw quotes, attributes get escaped quotes.
    expect(sanitizeTelegramHtml('[link](https://example.com/?q="x")')).toBe(
      '<a href="https://example.com/?q=&quot;x&quot;">link</a>',
    );
  });

  it('leaves " raw in heading content', () => {
    expect(sanitizeTelegramHtml('# This is "important"')).toBe(
      '<b>This is "important"</b>',
    );
  });
});
