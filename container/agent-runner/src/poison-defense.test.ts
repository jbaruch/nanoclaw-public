import { describe, it, expect } from 'vitest';

import {
  DEFAULT_TOOL_RESULT_MAX_BYTES,
  sanitizeText,
  sanitizeToolResponse,
  shouldDenyTaskOutputBlock,
} from './poison-defense.js';

// Invisible-Unicode characters in the Cf class. These render as zero
// width but tokenize, so they're the standard padding/smuggling vector.
const ZWSP = '\u200B';
const ZWNJ = '\u200C';
const ZWJ = '\u200D';
const BOM = '\uFEFF';
const RLM = '\u200F'; // Right-to-left mark, also Cf
// Use String.fromCodePoint for supplementary-plane chars — the literal
// glyph gets eaten by some editors / tooling and silently degrades to
// the empty string (caught in Copilot review on PR #151).
const LANG_TAG = String.fromCodePoint(0xe0065); // Cf-class language tag char

describe('sanitizeText', () => {
  it('strips standard zero-width characters', () => {
    const input = `hello${ZWSP}wo${ZWNJ}rld${ZWJ}!${BOM}`;
    const { out, stats } = sanitizeText(input, 1024);
    expect(out).toBe('helloworld!');
    expect(stats.strippedBytes).toBe(
      Buffer.byteLength(input, 'utf-8') - Buffer.byteLength('helloworld!', 'utf-8'),
    );
    expect(stats.truncatedBytes).toBe(0);
  });

  it('strips less-common Cf-class chars (RLM, language tag)', () => {
    const input = `a${RLM}b${LANG_TAG}c`;
    const { out } = sanitizeText(input, 1024);
    expect(out).toBe('abc');
  });

  it('passes normal text through bytewise unchanged', () => {
    const input = 'The quick brown fox jumps over the lazy dog. 1+1=2.';
    const { out, stats } = sanitizeText(input, 1024);
    expect(out).toBe(input);
    expect(stats.strippedBytes).toBe(0);
    expect(stats.truncatedBytes).toBe(0);
  });

  it('preserves non-Cf whitespace (spaces, newlines, tabs)', () => {
    const input = 'line one\n\tline two  with spaces\n';
    const { out } = sanitizeText(input, 1024);
    expect(out).toBe(input);
  });

  it('truncates with a marker when over the byte cap', () => {
    const input = 'x'.repeat(1000);
    const cap = 200;
    const { out, stats } = sanitizeText(input, cap);
    expect(out).toContain('truncated by tool_result sanitizer');
    // Final string must stay at or under the cap — marker bytes are
    // reserved out of the headroom, not appended past it.
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(cap);
    // truncatedBytes counts bytes dropped from the source (the marker
    // doesn't count as truncation).
    const markerBytes = Buffer.byteLength(
      '\n\n[truncated by tool_result sanitizer — original exceeded byte cap]',
      'utf-8',
    );
    expect(stats.truncatedBytes).toBe(1000 - (cap - markerBytes));
  });

  it('falls back to marker-only when byteCap is smaller than the marker', () => {
    const input = 'x'.repeat(1000);
    const { out, stats } = sanitizeText(input, 5);
    expect(out).toContain('truncated by tool_result sanitizer');
    expect(stats.truncatedBytes).toBe(1000);
  });

  it('strips first then truncates so cap reflects post-strip size', () => {
    // 50 bytes of payload + 50 bytes of zero-width padding.
    // After stripping, size is 50 — under a 60-byte cap, so no truncation.
    const payload = 'a'.repeat(50);
    const padding = ZWSP.repeat(50 / 3 + 1); // ZWSP is 3 UTF-8 bytes
    const input = payload + padding;
    const { out, stats } = sanitizeText(input, 60);
    expect(out).toBe(payload);
    expect(stats.truncatedBytes).toBe(0);
    expect(stats.strippedBytes).toBeGreaterThan(0);
  });
});

describe('sanitizeToolResponse', () => {
  it('walks content[].text blocks and sanitizes each', () => {
    const response = {
      content: [
        { type: 'text', text: `clean${ZWSP}block` },
        { type: 'text', text: `another${BOM}one` },
      ],
    };
    const { sanitized, stats } = sanitizeToolResponse(response, 1024);
    expect(sanitized).toEqual({
      content: [
        { type: 'text', text: 'cleanblock' },
        { type: 'text', text: 'anotherone' },
      ],
    });
    expect(stats.strippedBytes).toBeGreaterThan(0);
  });

  it('passes through non-text blocks (images, resources) untouched', () => {
    const imageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    };
    const response = { content: [imageBlock, { type: 'text', text: 'hi' }] };
    const { sanitized } = sanitizeToolResponse(response, 1024);
    expect((sanitized as { content: unknown[] }).content[0]).toBe(imageBlock);
  });

  it('passes through responses without a content array', () => {
    const response = { isError: true, message: 'tool failed' };
    const { sanitized, stats } = sanitizeToolResponse(response, 1024);
    expect(sanitized).toEqual(response);
    expect(stats.strippedBytes).toBe(0);
  });

  it('passes through non-object responses', () => {
    expect(sanitizeToolResponse(null, 1024).sanitized).toBeNull();
    expect(sanitizeToolResponse('a string', 1024).sanitized).toBe('a string');
    expect(sanitizeToolResponse(42, 1024).sanitized).toBe(42);
  });

  it('uses DEFAULT_TOOL_RESULT_MAX_BYTES when cap omitted', () => {
    const overCap = 'x'.repeat(DEFAULT_TOOL_RESULT_MAX_BYTES + 100);
    const response = { content: [{ type: 'text', text: overCap }] };
    const { sanitized, stats } = sanitizeToolResponse(response);
    expect(stats.truncatedBytes).toBeGreaterThanOrEqual(100);
    const text = (sanitized as { content: { text: string }[] }).content[0].text;
    expect(text).toContain('truncated by tool_result sanitizer');
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(
      DEFAULT_TOOL_RESULT_MAX_BYTES,
    );
  });

  it('preserves extra block fields (annotations, etc.)', () => {
    const response = {
      content: [{ type: 'text', text: 'hi', annotations: ['note'] }],
    };
    const { sanitized } = sanitizeToolResponse(response, 1024);
    expect((sanitized as { content: { annotations: string[] }[] }).content[0].annotations).toEqual(
      ['note'],
    );
  });

  it('walks bare-array responses and sanitizes each text block', () => {
    const response = [
      { type: 'text', text: `bare${ZWSP}array` },
      { type: 'text', text: `block${BOM}two` },
    ];
    const { sanitized, stats } = sanitizeToolResponse(response, 1024);
    expect(sanitized).toEqual([
      { type: 'text', text: 'barearray' },
      { type: 'text', text: 'blocktwo' },
    ]);
    expect(stats.strippedBytes).toBeGreaterThan(0);
  });

  it('truncates oversized text inside a bare-array response', () => {
    const overCap = 'x'.repeat(DEFAULT_TOOL_RESULT_MAX_BYTES + 100);
    const response = [{ type: 'text', text: overCap }];
    const { sanitized, stats } = sanitizeToolResponse(response);
    expect(stats.truncatedBytes).toBeGreaterThanOrEqual(100);
    const text = (sanitized as { text: string }[])[0].text;
    expect(text).toContain('truncated by tool_result sanitizer');
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(
      DEFAULT_TOOL_RESULT_MAX_BYTES,
    );
  });

  it('passes through bare arrays of non-text blocks untouched', () => {
    const imageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    };
    const { sanitized, stats } = sanitizeToolResponse([imageBlock], 1024);
    expect((sanitized as unknown[])[0]).toBe(imageBlock);
    expect(stats.strippedBytes).toBe(0);
  });
});

describe('shouldDenyTaskOutputBlock', () => {
  it('denies when block is undefined (SDK default is true)', () => {
    const result = shouldDenyTaskOutputBlock({ task_id: 'abc' });
    expect(result.deny).toBe(true);
    expect(result.reason).toContain('block: false');
  });

  it('denies when block is true', () => {
    expect(shouldDenyTaskOutputBlock({ task_id: 'abc', block: true }).deny).toBe(true);
  });

  it('denies non-boolean truthy values (defensive)', () => {
    expect(shouldDenyTaskOutputBlock({ task_id: 'abc', block: 'true' }).deny).toBe(true);
    expect(shouldDenyTaskOutputBlock({ task_id: 'abc', block: 1 }).deny).toBe(true);
  });

  it('allows when block is the literal boolean false', () => {
    expect(shouldDenyTaskOutputBlock({ task_id: 'abc', block: false }).deny).toBe(false);
  });

  it('allows malformed input through to SDK validation', () => {
    expect(shouldDenyTaskOutputBlock(null).deny).toBe(false);
    expect(shouldDenyTaskOutputBlock(undefined).deny).toBe(false);
    expect(shouldDenyTaskOutputBlock('not an object').deny).toBe(false);
  });
});
