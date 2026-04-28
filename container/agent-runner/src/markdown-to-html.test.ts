import { describe, it, expect } from 'vitest';

import { rewriteMarkdownToHtml } from './markdown-to-html.js';

describe('rewriteMarkdownToHtml', () => {
  describe('bold', () => {
    it('converts **bold** to <b>bold</b>', () => {
      const r = rewriteMarkdownToHtml('hello **world**');
      expect(r.out).toBe('hello <b>world</b>');
      expect(r.stats.bold).toBe(1);
      expect(r.changed).toBe(true);
    });

    it('handles multiple bold spans on one line', () => {
      const r = rewriteMarkdownToHtml('**a** and **b** and **c**');
      expect(r.out).toBe('<b>a</b> and <b>b</b> and <b>c</b>');
      expect(r.stats.bold).toBe(3);
    });

    it('escapes < & > inside the bold span', () => {
      const r = rewriteMarkdownToHtml('**a < b & <c>**');
      expect(r.out).toBe('<b>a &lt; b &amp; &lt;c&gt;</b>');
    });

    it('does not span newlines', () => {
      const r = rewriteMarkdownToHtml('**unterminated\nnext line**');
      expect(r.out).toBe('**unterminated\nnext line**');
      expect(r.stats.bold).toBe(0);
      expect(r.changed).toBe(false);
    });
  });

  describe('links', () => {
    it('converts [text](url) to <a href>', () => {
      const r = rewriteMarkdownToHtml('see [docs](https://example.com)');
      expect(r.out).toBe('see <a href="https://example.com">docs</a>');
      expect(r.stats.links).toBe(1);
    });

    it('escapes ampersands in the URL', () => {
      const r = rewriteMarkdownToHtml('[q](https://x.com/?a=1&b=2)');
      expect(r.out).toBe('<a href="https://x.com/?a=1&amp;b=2">q</a>');
    });

    it('escapes < & > in the link label', () => {
      const r = rewriteMarkdownToHtml('[a < b & <script>](https://x.com)');
      expect(r.out).toBe(
        '<a href="https://x.com">a &lt; b &amp; &lt;script&gt;</a>',
      );
    });

    it('does not match across lines', () => {
      const r = rewriteMarkdownToHtml('[broken\nlabel](url)');
      expect(r.changed).toBe(false);
    });
  });

  describe('code spans', () => {
    it('converts `code` to <code>code</code>', () => {
      const r = rewriteMarkdownToHtml('try `npm test`');
      expect(r.out).toBe('try <code>npm test</code>');
      expect(r.stats.codeSpans).toBe(1);
    });

    it('escapes < & inside code spans', () => {
      const r = rewriteMarkdownToHtml('`a < b && c`');
      expect(r.out).toBe('<code>a &lt; b &amp;&amp; c</code>');
    });
  });

  describe('bullet lines', () => {
    it('converts dash bullets to •', () => {
      const r = rewriteMarkdownToHtml('- one\n- two\n- three');
      expect(r.out).toBe('• one\n• two\n• three');
      expect(r.stats.bulletLines).toBe(3);
    });

    it('converts star bullets', () => {
      const r = rewriteMarkdownToHtml('* one\n* two');
      expect(r.out).toBe('• one\n• two');
      expect(r.stats.bulletLines).toBe(2);
    });

    it('does not eat ** bold openers when scanning bullets', () => {
      const r = rewriteMarkdownToHtml('**not a bullet**');
      // bullet count zero; bold rewrite still happens
      expect(r.stats.bulletLines).toBe(0);
      expect(r.out).toBe('<b>not a bullet</b>');
    });

    it('preserves leading indentation', () => {
      const r = rewriteMarkdownToHtml('  - indented item');
      expect(r.out).toBe('  • indented item');
    });
  });

  describe('code-block protection', () => {
    it('passes ``` fences through bytewise', () => {
      const input = 'before\n```\n**not bold** and `code` and - bullet\n```\nafter **yes bold**';
      const r = rewriteMarkdownToHtml(input);
      expect(r.out).toBe(
        'before\n```\n**not bold** and `code` and - bullet\n```\nafter <b>yes bold</b>',
      );
      expect(r.stats.bold).toBe(1);
      expect(r.stats.codeSpans).toBe(0);
      expect(r.stats.bulletLines).toBe(0);
    });

    it('passes <pre> blocks through bytewise', () => {
      const input = '<pre>**not bold**</pre> and **bold**';
      const r = rewriteMarkdownToHtml(input);
      expect(r.out).toBe('<pre>**not bold**</pre> and <b>bold</b>');
    });

    it('passes <code> blocks through bytewise', () => {
      const input = '<code>**raw**</code> and **rewritten**';
      const r = rewriteMarkdownToHtml(input);
      expect(r.out).toBe('<code>**raw**</code> and <b>rewritten</b>');
    });

    it('handles unclosed ``` by protecting to end of string', () => {
      const input = 'prefix **bold**\n```\nuncoded **stays**';
      const r = rewriteMarkdownToHtml(input);
      expect(r.out).toBe('prefix <b>bold</b>\n```\nuncoded **stays**');
    });
  });

  describe('combined patterns', () => {
    it('rewrites a realistic mixed message', () => {
      const input = [
        '**Daily brief**',
        '',
        '- 3 PRs open',
        '- see [#171](https://github.com/jbaruch/nanoclaw/pull/171)',
        '',
        'Run `npm test` to verify.',
      ].join('\n');
      const r = rewriteMarkdownToHtml(input);
      expect(r.out).toBe(
        [
          '<b>Daily brief</b>',
          '',
          '• 3 PRs open',
          '• see <a href="https://github.com/jbaruch/nanoclaw/pull/171">#171</a>',
          '',
          'Run <code>npm test</code> to verify.',
        ].join('\n'),
      );
      expect(r.stats.bold).toBe(1);
      expect(r.stats.bulletLines).toBe(2);
      expect(r.stats.links).toBe(1);
      expect(r.stats.codeSpans).toBe(1);
      expect(r.changed).toBe(true);
    });
  });

  describe('no-op cases', () => {
    it('returns unchanged for plain text', () => {
      const r = rewriteMarkdownToHtml('just some plain text.');
      expect(r.out).toBe('just some plain text.');
      expect(r.changed).toBe(false);
    });

    it('returns unchanged for empty string', () => {
      const r = rewriteMarkdownToHtml('');
      expect(r.changed).toBe(false);
    });

    it('returns empty string for non-string input', () => {
      const r = rewriteMarkdownToHtml(42);
      expect(r.out).toBe('');
      expect(r.changed).toBe(false);
    });

    it('preserves bare HTML untouched', () => {
      const r = rewriteMarkdownToHtml('<b>already bold</b> and <i>italic</i>');
      expect(r.out).toBe('<b>already bold</b> and <i>italic</i>');
      expect(r.changed).toBe(false);
    });
  });
});
