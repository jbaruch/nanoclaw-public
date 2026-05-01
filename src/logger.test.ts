/**
 * Tests for the token-redaction layer in `logger`.
 *
 * Grammy's `HttpError` / `FetchError` messages embed the full bot URL
 * (token and all) as part of the error string, and our `formatErr`
 * writes `err.message` + `err.stack` verbatim. Without redaction, every
 * Telegram send failure lands the token in `logs/nanoclaw.log` —
 * the exact failure mode this module prevents.
 *
 * The tests exercise each payload shape the logger can receive:
 *
 *   - A plain string message containing the token
 *   - A structured data object carrying the token in one of its fields
 *   - An `Error` instance whose `.message` and `.stack` both carry it
 *     (this is the grammy shape)
 *
 * All three paths funnel through the same `redactBotTokens` filter
 * applied at write time, so catching the filter in one shape catches
 * it in all — but the tests cover each explicitly to pin the contract
 * and catch regressions if someone refactors the format pipeline.
 *
 * Token fixtures are SYNTHETIC — they match the redaction regex shape
 * (`bot\d+:[A-Za-z0-9_-]+`) but are intentionally short, all-zero-ish,
 * and not format-similar to real Telegram bot tokens. Using real-shape
 * strings in test code trips GitHub secret scanning and, worse,
 * embeds real-looking credentials in public commit history even when
 * they're meant to be fake.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';

// The logger reads `LOG_LEVEL` ONCE at module load and computes
// `threshold` from it — if the test runner/CI sets `LOG_LEVEL=warn`
// (or `error` / `fatal`), `logger.info(...)` is a no-op, no write
// reaches stdout, and the "redacts X in string log message" assertion
// vacuously fails on the absence of output rather than on actual
// redaction behaviour.
//
// Pin to `info` explicitly and dynamic-import the module AFTER the
// env var is set so the new threshold is what the tests see. Restore
// whatever the runner originally had in `afterAll` so we don't
// pollute subsequent test files.
const ORIGINAL_LOG_LEVEL = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = 'info';
vi.resetModules();
const { logger, redactBotTokens } = await import('./logger.js');

afterAll(() => {
  if (ORIGINAL_LOG_LEVEL === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = ORIGINAL_LOG_LEVEL;
  }
});

// Fake numeric ID + fake short secret. Matches the regex; obviously not real.
const FAKE_BOT_ID = '1111111111';
const FAKE_SECRET = 'fakeSecretAAAA';
const FAKE_TOKEN = `${FAKE_BOT_ID}:${FAKE_SECRET}`;

describe('redactBotTokens', () => {
  it('replaces the secret portion but keeps the bot ID for correlation', () => {
    const url = `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`;
    expect(redactBotTokens(url)).toBe(
      `https://api.telegram.org/bot${FAKE_BOT_ID}:<redacted>/sendMessage`,
    );
  });

  it('redacts every occurrence in a multi-token string', () => {
    const SECOND_ID = '2222222222';
    const SECOND_SECRET = 'fakeSecretBBBB';
    const input = `token1=bot${FAKE_TOKEN} token2=bot${SECOND_ID}:${SECOND_SECRET}`;
    const out = redactBotTokens(input);
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).not.toContain(SECOND_SECRET);
    expect(out).toContain(`bot${FAKE_BOT_ID}:<redacted>`);
    expect(out).toContain(`bot${SECOND_ID}:<redacted>`);
  });

  it('leaves unrelated strings untouched', () => {
    const s = 'just a regular log line with no token in it at all';
    expect(redactBotTokens(s)).toBe(s);
  });
});

describe('logger redacts tokens in all output shapes', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let writes: string[] = [];

  beforeEach(() => {
    writes = [];
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('redacts when the token is in a plain-string log message', () => {
    logger.info(
      `sending to https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`,
    );
    const combined = writes.join('');
    expect(combined).not.toContain(FAKE_SECRET);
    expect(combined).toContain(`bot${FAKE_BOT_ID}:<redacted>`);
  });

  it('redacts when the token is a value in structured data', () => {
    logger.info(
      {
        url: `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`,
        method: 'POST',
      },
      'Outbound call',
    );
    const combined = writes.join('');
    expect(combined).not.toContain(FAKE_SECRET);
    expect(combined).toContain(`bot${FAKE_BOT_ID}:<redacted>`);
  });

  it('redacts when the token is embedded in an Error message (grammy shape)', () => {
    // Shape of grammy's FetchError — Error subclass whose `.message`
    // contains the full bot URL. Our `formatErr` writes message +
    // stack verbatim; the redact layer has to catch both.
    const err = new Error(
      `request to https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage failed`,
    );
    logger.error({ err }, 'Failed to send Telegram message');
    const combined = writes.join('');
    expect(combined).not.toContain(FAKE_SECRET);
    // Bot ID should still be present for correlation
    expect(combined).toContain(`bot${FAKE_BOT_ID}:<redacted>`);
  });
});
