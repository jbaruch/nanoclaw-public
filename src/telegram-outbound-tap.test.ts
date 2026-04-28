/**
 * Focused tests for `telegram-outbound-tap`.
 *
 * The tap mutates `globalThis.fetch`, `http.request`, `https.request`,
 * `http.get`, and `https.get` as a side effect of
 * `installTelegramOutboundTap()` — unusual shape for the codebase, so
 * tests verify:
 *
 *   1. Gate: when `LOG_LEVEL !== 'debug'`, nothing is wrapped (info-
 *      level production must stay on the hot path, zero cost).
 *   2. Gate: when `LOG_LEVEL === 'debug'`, matching fetch and
 *      http(s).request calls log at debug with a REDACTED URL (no
 *      secret bytes).
 *   3. Non-Telegram calls on the same surface aren't logged (we don't
 *      want to drown the log in every HTTP call the orchestrator
 *      makes).
 *
 * We test fetch + http(s).request explicitly. The `http.get` /
 * `https.get` branches share the same install-time wrap pattern — a
 * dedicated test there would be repetitive at best and would need to
 * stub node internals at worst; the code review before merge is the
 * guard against that branch drifting.
 *
 * Token fixtures are SYNTHETIC (short, all-zero-ish) so they match the
 * redaction regex shape without looking like real Telegram bot
 * tokens — avoids tripping GitHub secret scanning on test code.
 *
 * Between tests we call `__resetTelegramOutboundTapForTests()` — the
 * tap mutates five globals and without a proper restore, a first
 * test's install would leak its wrappers into the next test's
 * assertions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import https from 'https';
import {
  installTelegramOutboundTap,
  __resetTelegramOutboundTapForTests,
} from './telegram-outbound-tap.js';

const FAKE_BOT_ID = '1111111111';
const FAKE_SECRET = 'fakeSecretAAAA';
const FAKE_TOKEN = `${FAKE_BOT_ID}:${FAKE_SECRET}`;

describe('installTelegramOutboundTap', () => {
  const origLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    __resetTelegramOutboundTapForTests();
  });

  afterEach(() => {
    __resetTelegramOutboundTapForTests();
    if (origLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = origLogLevel;
    }
  });

  it('returns false and leaves fetch untouched when LOG_LEVEL is not debug', () => {
    process.env.LOG_LEVEL = 'info';
    const before = globalThis.fetch;
    const result = installTelegramOutboundTap();
    expect(result).toBe(false);
    expect(globalThis.fetch).toBe(before);
  });

  it('wraps fetch: logs redacted Telegram calls, skips non-Telegram calls', async () => {
    process.env.LOG_LEVEL = 'debug';

    // Mock fetch so the wrapped version returns without a real network
    // call. Assign BEFORE the tap installs so the tap's captured
    // `origFetch` points at the mock.
    const fakeFetch = vi.fn(async () => new Response('ok'));
    globalThis.fetch = fakeFetch as unknown as typeof fetch;

    const loggerMod = await import('./logger.js');
    const debugSpy = vi
      .spyOn(loggerMod.logger, 'debug')
      .mockImplementation(() => {});

    expect(installTelegramOutboundTap()).toBe(true);

    // Positive call: Telegram URL with token — must log, redacted.
    const tokenUrl = `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`;
    await globalThis.fetch(tokenUrl, { method: 'POST' });

    // Negative call in the SAME test: OpenAI URL must not trigger
    // a [tg-tap] log. Keeping both in one test avoids the cross-test
    // state-bleed risk that comes with multiple install/reset cycles
    // each manipulating globalThis.fetch.
    await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
    });

    // Underlying fetch called for BOTH — the tap wraps, never intercepts.
    expect(fakeFetch).toHaveBeenCalledTimes(2);

    const tapCalls = debugSpy.mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('[tg-tap]'),
    );
    // Exactly one `[tg-tap]` emission — the Telegram call. OpenAI
    // silent.
    expect(tapCalls).toHaveLength(1);

    const data = tapCalls[0][0] as Record<string, unknown>;
    // Redaction: the bot ID stays for correlation, secret bytes go.
    // Positive assertion AND negative — we care both that the
    // replacement happened and that the secret can't sneak through
    // any other field.
    expect(data.url).toBe(
      `https://api.telegram.org/bot${FAKE_BOT_ID}:<redacted>/sendMessage`,
    );
    expect(JSON.stringify(data)).not.toContain(FAKE_SECRET);
    expect(data.method).toBe('POST');

    debugSpy.mockRestore();
  });

  it('wraps http.request / https.request: logs Telegram-host calls, skips others', async () => {
    process.env.LOG_LEVEL = 'debug';

    // Stub the underlying request so no real network I/O happens.
    // Both http and https module namespaces are mutated in place by
    // the tap, so we stub BEFORE install so the tap captures these
    // stubs as its `origRequest`.
    const httpStub = vi.fn(() => ({ end: vi.fn() }) as unknown);
    const httpsStub = vi.fn(() => ({ end: vi.fn() }) as unknown);
    http.request = httpStub as unknown as typeof http.request;
    https.request = httpsStub as unknown as typeof https.request;

    const loggerMod = await import('./logger.js');
    const debugSpy = vi
      .spyOn(loggerMod.logger, 'debug')
      .mockImplementation(() => {});

    installTelegramOutboundTap();

    // Positive: Telegram URL via https.request — must log.
    https.request(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`, {
      method: 'POST',
    });
    // Negative: unrelated host via http.request — must NOT log.
    http.request('http://localhost:8080/health', { method: 'GET' });

    // Underlying stubs were called for both — the tap wraps, never
    // intercepts.
    expect(httpsStub).toHaveBeenCalledTimes(1);
    expect(httpStub).toHaveBeenCalledTimes(1);

    const tapCalls = debugSpy.mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('[tg-tap]'),
    );
    // Exactly one `[tg-tap]` emission — the Telegram call.
    expect(tapCalls).toHaveLength(1);

    const data = tapCalls[0][0] as Record<string, unknown>;
    expect(data.via).toBe('https.request');
    expect(data.url).toBe(
      `https://api.telegram.org/bot${FAKE_BOT_ID}:<redacted>/sendMessage`,
    );
    expect(JSON.stringify(data)).not.toContain(FAKE_SECRET);
    expect(data.method).toBe('POST');

    debugSpy.mockRestore();
  });
});
