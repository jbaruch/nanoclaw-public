import { describe, it, expect } from 'vitest';
import {
  encodeRfc2822Draft,
  truncateThread,
} from './onecli-mcp-stdio.js';
import { extractHistoryCursor } from './onecli-smartthings-mcp-stdio.js';

// --- encodeRfc2822Draft (post library swap to nodemailer) ---
//
// Goal: pin the contract — Gmail's drafts/messages endpoints want
// a base64url-encoded RFC 2822 message. The hand-rolled implementation
// got these wrong on edge cases; the library doesn't, but the test
// suite is what catches a regression if a future change accidentally
// reverts to hand-rolled.

describe('encodeRfc2822Draft — output shape', () => {
  it('produces base64url (no +, no /, no padding)', async () => {
    const out = await encodeRfc2822Draft({
      to: 'a@b.com',
      subject: 'hi',
      body: 'hello world',
    });
    expect(out).not.toMatch(/\+/);
    expect(out).not.toMatch(/\//);
    expect(out).not.toMatch(/=$/);
    expect(out).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('round-trips back to a MIME message containing To, Subject, body', async () => {
    const out = await encodeRfc2822Draft({
      to: 'recipient@example.com',
      subject: 'meeting at 3',
      body: 'see you then',
    });
    const decoded = Buffer.from(
      out.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf-8');
    expect(decoded).toContain('To:');
    expect(decoded).toContain('recipient@example.com');
    expect(decoded).toContain('Subject:');
    expect(decoded).toContain('meeting at 3');
    expect(decoded).toContain('see you then');
  });

  it('uses CRLF line endings (Gmail wants it; LF rejected by some MTAs)', async () => {
    const out = await encodeRfc2822Draft({
      to: 'a@b.com',
      subject: 's',
      body: 'b',
    });
    const decoded = Buffer.from(
      out.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf-8');
    expect(decoded).toMatch(/\r\n/);
  });

  it('encodes non-ASCII subject (RFC 2047 / encoded-word) — the case the hand-rolled impl could not handle', async () => {
    const out = await encodeRfc2822Draft({
      to: 'a@b.com',
      subject: 'café — résumé attached',
      body: 'en pièce jointe',
    });
    const decoded = Buffer.from(
      out.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf-8');
    // RFC 2047 encoded-word OR raw UTF-8 (depends on library); the
    // critical thing is we don't have a raw `café` byte sequence as
    // an unencoded-non-ASCII subject (which Gmail rejects).
    const subjectLine = decoded.split(/\r\n/).find((l) => l.startsWith('Subject:'));
    expect(subjectLine).toBeDefined();
    // Either =?utf-8?...?= encoded or charset-tagged — must not be
    // unannotated raw 8-bit on a header line.
    if (subjectLine && /[^\x00-\x7f]/.test(subjectLine)) {
      // If raw UTF-8 made it onto the header line, it must be paired
      // with a Content-Type header that declares charset=UTF-8 — which
      // the body has, but headers themselves should be 7-bit safe.
      // nodemailer encodes them; this branch should not trigger.
      expect(subjectLine).toMatch(/=\?[uU][tT][fF]-8\?/);
    }
  });

  it('threads via In-Reply-To / References when provided', async () => {
    const out = await encodeRfc2822Draft({
      to: 'a@b.com',
      subject: 'Re: hi',
      body: 'reply',
      inReplyTo: '<orig-id@example.com>',
      references: '<thread-1@example.com> <thread-2@example.com>',
    });
    const decoded = Buffer.from(
      out.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf-8');
    expect(decoded).toContain('In-Reply-To: <orig-id@example.com>');
    expect(decoded).toContain('References: <thread-1@example.com> <thread-2@example.com>');
  });

  it('omits CC / BCC headers when not provided', async () => {
    const out = await encodeRfc2822Draft({
      to: 'a@b.com',
      subject: 's',
      body: 'b',
    });
    const decoded = Buffer.from(
      out.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf-8');
    // Match the start of any line, not substring (so we don't false-
    // match on a body that happens to mention "Cc:").
    const lines = decoded.split(/\r\n/);
    expect(lines.find((l) => l.startsWith('Cc:'))).toBeUndefined();
    expect(lines.find((l) => l.startsWith('Bcc:'))).toBeUndefined();
  });

  it('emits CC and BCC when provided', async () => {
    const out = await encodeRfc2822Draft({
      to: 'a@b.com',
      subject: 's',
      body: 'b',
      cc: 'c@d.com',
      bcc: 'e@f.com',
    });
    const decoded = Buffer.from(
      out.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf-8');
    expect(decoded).toContain('c@d.com');
    expect(decoded).toContain('e@f.com');
  });
});

// --- truncateThread ---
//
// The recursive walk on payload.parts is the kind of code that breaks
// silently when Gmail's response shape changes; pin the contract.

describe('truncateThread — message count cap', () => {
  it('keeps the LAST maxMessages (most recent), drops earlier ones', () => {
    const data = {
      messages: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }],
    };
    truncateThread(data, {
      maxMessages: 2,
      bodyMaxChars: 1000,
      includeBodies: false,
    });
    expect(data.messages?.map((m) => m.id)).toEqual(['3', '4']);
    expect((data as Record<string, unknown>)._truncated).toMatchObject({
      kept: 2,
      dropped: 2,
    });
  });

  it('does not stamp _truncated when count is at-or-below the cap', () => {
    const data = { messages: [{ id: '1' }, { id: '2' }] };
    truncateThread(data, {
      maxMessages: 5,
      bodyMaxChars: 1000,
      includeBodies: false,
    });
    expect((data as Record<string, unknown>)._truncated).toBeUndefined();
  });

  it('handles missing messages array (Gmail occasionally returns no body)', () => {
    const data: { messages?: Array<Record<string, unknown>> } &
      Record<string, unknown> = {};
    expect(() =>
      truncateThread(data, {
        maxMessages: 5,
        bodyMaxChars: 1000,
        includeBodies: false,
      }),
    ).not.toThrow();
  });
});

describe('truncateThread — body truncation', () => {
  // The 1.4 factor accounts for base64 overhead. With bodyMaxChars=100,
  // limit=140 — strings >140 chars get sliced, anything ≤140 is kept.
  it('does not truncate body within the base64-adjusted limit', () => {
    const data = {
      messages: [
        {
          payload: {
            body: { data: 'x'.repeat(140) },
          },
        },
      ],
    };
    truncateThread(data, {
      maxMessages: 5,
      bodyMaxChars: 100,
      includeBodies: true,
    });
    const body = (data.messages[0].payload as { body: { data: string; _truncated?: boolean } }).body;
    expect(body.data.length).toBe(140);
    expect(body._truncated).toBeUndefined();
  });

  it('truncates body past the base64-adjusted limit + stamps _truncated', () => {
    const data = {
      messages: [
        {
          payload: {
            body: { data: 'x'.repeat(500) },
          },
        },
      ],
    };
    truncateThread(data, {
      maxMessages: 5,
      bodyMaxChars: 100,
      includeBodies: true,
    });
    const body = (data.messages[0].payload as { body: { data: string; _truncated?: boolean } }).body;
    expect(body.data.length).toBe(140);
    expect(body._truncated).toBe(true);
  });

  it('walks nested parts recursively (multipart/alternative shape)', () => {
    const data = {
      messages: [
        {
          payload: {
            parts: [
              { body: { data: 'a'.repeat(500) } },
              {
                parts: [{ body: { data: 'b'.repeat(500) } }],
              },
            ],
          },
        },
      ],
    };
    truncateThread(data, {
      maxMessages: 5,
      bodyMaxChars: 100,
      includeBodies: true,
    });
    const payload = data.messages[0].payload as { parts: Array<Record<string, unknown>> };
    const top = payload.parts[0] as { body: { data: string; _truncated?: boolean } };
    const nested = (payload.parts[1] as { parts: Array<Record<string, unknown>> })
      .parts[0] as { body: { data: string; _truncated?: boolean } };
    expect(top.body.data.length).toBe(140);
    expect(top.body._truncated).toBe(true);
    expect(nested.body.data.length).toBe(140);
    expect(nested.body._truncated).toBe(true);
  });

  it('skips body truncation when includeBodies is false', () => {
    const data = {
      messages: [
        {
          payload: { body: { data: 'x'.repeat(10000) } },
        },
      ],
    };
    truncateThread(data, {
      maxMessages: 5,
      bodyMaxChars: 100,
      includeBodies: false,
    });
    const body = (data.messages[0].payload as { body: { data: string; _truncated?: boolean } }).body;
    expect(body.data.length).toBe(10000);
    expect(body._truncated).toBeUndefined();
  });
});

// --- extractHistoryCursor (SmartThings) ---
//
// Pin the cursor format because if it parses to null where a real
// cursor exists, agents can't page back through device history;
// if it parses to bad numbers, the next call sends garbage to ST
// and either gets a 400 or (worse) returns wrong-window results.

describe('extractHistoryCursor — null on missing/malformed', () => {
  it('returns null when href is undefined', () => {
    expect(extractHistoryCursor(undefined)).toBeNull();
  });

  it('returns null when href is null', () => {
    expect(extractHistoryCursor(null)).toBeNull();
  });

  it('returns null when href is empty', () => {
    expect(extractHistoryCursor('')).toBeNull();
  });

  it('returns null when href is not a valid URL', () => {
    expect(extractHistoryCursor('not a url')).toBeNull();
  });

  it('returns null when neither expected param is present', () => {
    expect(
      extractHistoryCursor('https://api.smartthings.com/v1/history/devices'),
    ).toBeNull();
  });

  it('returns null when only epoch is present', () => {
    expect(
      extractHistoryCursor(
        'https://api.smartthings.com/v1/history/devices?pagingBeforeEpoch=1700000000000',
      ),
    ).toBeNull();
  });

  it('returns null when only hash is present', () => {
    expect(
      extractHistoryCursor(
        'https://api.smartthings.com/v1/history/devices?pagingBeforeHash=12345',
      ),
    ).toBeNull();
  });

  it('returns null when params are present but non-numeric', () => {
    expect(
      extractHistoryCursor(
        'https://api.smartthings.com/v1/history/devices?pagingBeforeEpoch=abc&pagingBeforeHash=def',
      ),
    ).toBeNull();
  });
});

describe('extractHistoryCursor — happy path', () => {
  it('extracts both params from a well-formed href', () => {
    const cursor = extractHistoryCursor(
      'https://api.smartthings.com/v1/history/devices?pagingBeforeEpoch=1700000000000&pagingBeforeHash=12345',
    );
    expect(cursor).toEqual({ epoch: 1700000000000, hash: 12345 });
  });

  it('handles negative hash values (ST sometimes uses negatives)', () => {
    const cursor = extractHistoryCursor(
      'https://api.smartthings.com/v1/history/devices?pagingBeforeEpoch=1700000000000&pagingBeforeHash=-99',
    );
    expect(cursor).toEqual({ epoch: 1700000000000, hash: -99 });
  });

  it('survives extra unrelated query params', () => {
    const cursor = extractHistoryCursor(
      'https://api.smartthings.com/v1/history/devices?locationId=loc-1&pagingBeforeEpoch=1700000000000&deviceId=dev-1&pagingBeforeHash=42&limit=50',
    );
    expect(cursor).toEqual({ epoch: 1700000000000, hash: 42 });
  });
});
