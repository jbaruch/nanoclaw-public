/**
 * Outbound Telegram HTTP tap — process-wide instrumentation.
 *
 * The grammy `api.config.use` transformer from PR #87 sits at ONE specific
 * layer: every outbound call that flows through `this.bot.api.*`. Issue #81
 * ghost messages don't show up in that transformer's logs, which means the
 * send — if it's happening in this process at all — is leaving by a path
 * that doesn't reuse the main Bot's Api instance.
 *
 * This tap wraps the lower-level egress points the orchestrator process
 * can use to reach `api.telegram.org`:
 *
 *   - `globalThis.fetch`   (undici — Node 18+ default; callers that
 *     read `globalThis.fetch` at call time pick up the wrapper, but
 *     any reference captured earlier — e.g. `const f = fetch` at a
 *     module's top level, or an `import { fetch }` alias snapshot —
 *     bypasses the tap. Same caveat as the http/https branch below.)
 *   - `http.request` / `https.request` / `http.get` / `https.get` via
 *     the module namespace object (mutated in place). Works for callers
 *     that do namespace imports: `import https from 'https';
 *     https.request(...)` — which includes grammy itself when
 *     `baseFetchConfig.agent: https.globalAgent` is set in Bot opts
 *     (see `src/channels/telegram.ts`). `get` is wrapped separately
 *     from `request` because Node's internal `get()` calls the module-
 *     scoped `request` function directly, not `exports.request`, so
 *     wrapping `request` alone would miss `https.get('...')` callers
 *     entirely (and we have at least one — `downloadTelegramFile`).
 *
 * ## Scope and known gaps
 *
 * The tap does NOT catch callers that do NAMED imports from http /
 * https / child_process (e.g. `import { request } from 'http'`). ESM
 * binds named imports from CJS modules at link time — mutating the
 * CJS `module.exports` after link doesn't propagate to those
 * pre-captured references. Existing in-repo consumers that would fall
 * in this blind spot (grep for `import { request as httpRequest }`
 * etc.) point at the Anthropic credential proxy, not Telegram, so
 * today's coverage is sufficient for #81's hypothesis space.
 *
 * Child-process shell-outs (`spawn`/`exec`/`execFile`) are deliberately
 * NOT wrapped here: named-import callers (`ipc.ts`, `session-cleanup.ts`,
 * `remote-control.ts`, `container-runner.ts`) would silently bypass any
 * module-level mutation, making the coverage false-positively reassuring.
 * If the ghost sender turns out to be a child-process shell-out, the
 * host-level `ss` watcher in PR #92 catches it by process PID — a
 * strictly stronger instrument for cross-process traffic. The two
 * tools are complementary: #89 catches in-process HTTP, #92 catches
 * anything that opens a socket to Telegram's IP range regardless of
 * process.
 *
 * ## Gating and redaction
 *
 * Gated on `LOG_LEVEL=debug` to match #87's gate. At `info` or higher
 * the tap is NOT installed — zero overhead on the hot path.
 *
 * Every log emission rewrites `bot\d+:[A-Za-z0-9_-]+` fragments to
 * `bot<id>:<redacted>` before calling the logger. Bot ID stays so
 * operators can correlate main (`8460672283`) vs the six pool bots;
 * the secret bytes never land on disk.
 */

import http from 'http';
import https from 'https';

import { logger } from './logger.js';

const TELEGRAM_HOST = 'api.telegram.org';
const BOT_TOKEN_RE = /bot(\d+):[A-Za-z0-9_-]+/g;

/**
 * Redact the secret portion of any `bot<id>:<token>` fragment while
 * preserving `<id>` — we need the bot ID to correlate ghost sends with
 * which of the 7 pool/main identities emitted them.
 */
function redactTokens(input: string): string {
  return input.replace(BOT_TOKEN_RE, 'bot$1:<redacted>');
}

/**
 * Best-effort URL extraction from a fetch input. Accepts the same shapes
 * as `globalThis.fetch`: string, URL, Request. A non-stringifiable input
 * is ignored — we'd rather miss one log line than crash the orchestrator.
 */
function fetchInputToUrl(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (
    input &&
    typeof input === 'object' &&
    'url' in input &&
    typeof (input as { url: unknown }).url === 'string'
  ) {
    return (input as { url: string }).url;
  }
  return null;
}

/**
 * Best-effort URL extraction from the polymorphic `http.request(url, options, cb)`
 * / `http.request(options, cb)` signature. Returns a display URL — may be
 * incomplete (e.g. path-only when only `options` was passed), but enough
 * to decide whether `TELEGRAM_HOST` is involved.
 */
function httpArgsToUrl(
  args: unknown[],
  defaultProtocol: 'http:' | 'https:',
): string | null {
  // Form 1: (url, options?, cb?)
  if (typeof args[0] === 'string') return args[0];
  if (args[0] instanceof URL) return args[0].toString();
  // Form 2: (options, cb?) where options has { host, hostname, path, port, protocol }
  if (args[0] && typeof args[0] === 'object') {
    const o = args[0] as {
      host?: string;
      hostname?: string;
      path?: string;
      port?: string | number;
      protocol?: string;
    };
    const host = o.hostname || o.host;
    if (!host) return null;
    const protocol = o.protocol || defaultProtocol;
    const port = o.port ? `:${o.port}` : '';
    const path = o.path || '/';
    return `${protocol}//${host}${port}${path}`;
  }
  return null;
}

function stackHere(): string {
  // `new Error().stack` captures the synchronous chain. Drop the
  // initial "Error" header line plus the next two frames (this
  // helper itself and the wrapper that called it) so operators see
  // the caller of the tapped function at the top of the slice.
  return new Error().stack?.split('\n').slice(3, 15).join('\n') || '';
}

function touchesTelegram(text: string | null): boolean {
  if (!text) return false;
  return text.includes(TELEGRAM_HOST) || /bot\d+:[A-Za-z0-9_-]+/.test(text);
}

let installed = false;

/**
 * Install the tap. Idempotent — calling twice is a no-op so tests that
 * import this module twice don't double-wrap.
 *
 * Returns `true` if the tap is now active, `false` if the gate was
 * closed. Callers don't need the return value in production; it's there
 * for tests.
 */
export function installTelegramOutboundTap(): boolean {
  if (installed) return true;
  if (process.env.LOG_LEVEL !== 'debug') return false;
  installed = true;

  // ── globalThis.fetch ──────────────────────────────────────────────
  const origFetch = globalThis.fetch;
  if (typeof origFetch === 'function') {
    globalThis.fetch = async function tappedFetch(
      this: unknown,
      input: Parameters<typeof origFetch>[0],
      init?: Parameters<typeof origFetch>[1],
    ): Promise<Response> {
      const url = fetchInputToUrl(input);
      if (touchesTelegram(url)) {
        // Check on the RAW url, log the REDACTED url. Matters when a
        // caller passes only a `bot<id>:<token>` fragment without the
        // `api.telegram.org` hostname — redacting first would turn
        // `bot123:abc` into `bot123:<redacted>` which the touches-
        // check would miss.
        logger.debug(
          {
            via: 'fetch',
            url: redactTokens(url || ''),
            method: init?.method || 'GET',
            stack: stackHere(),
          },
          '[tg-tap] outbound Telegram HTTP',
        );
      }
      return origFetch.call(this, input, init);
    } as typeof origFetch;
  }

  // ── http.request / https.request / http.get / https.get ──────────
  // Mutating the module namespace object works for callers that use
  // namespace imports (e.g. grammy's `import https from 'https'`).
  // Named-import callers (`import { request } from 'http'`) are NOT
  // covered — see the module-level docstring for the tradeoff.
  //
  // IMPORTANT: `http.get` and `https.get` are wrapped separately.
  // Node's implementation of `get()` calls the MODULE-SCOPED `request`
  // function directly, not `exports.request` — so our `mod.request =
  // wrapped` mutation does NOT route `get()` traffic through the tap.
  // Without wrapping `get` explicitly, a caller that does
  // `https.get(url, cb)` (e.g. our own `downloadTelegramFile` at
  // `telegram.ts:315`) bypasses the tap entirely.
  const logHttpCall = (
    via: 'http.request' | 'https.request' | 'http.get' | 'https.get',
    url: string | null,
    args: unknown[],
  ): void => {
    // `method` lives on the options arg (form 2) or the second arg
    // (form 1). Best-effort — if we can't read it, skip the field.
    let method = 'GET';
    for (const a of args) {
      if (a && typeof a === 'object' && 'method' in a) {
        const m = (a as { method?: unknown }).method;
        if (typeof m === 'string') {
          method = m;
          break;
        }
      }
    }
    logger.debug(
      {
        via,
        url: redactTokens(url || ''),
        method,
        stack: stackHere(),
      },
      '[tg-tap] outbound Telegram HTTP',
    );
  };

  const wrapHttp = (
    mod: typeof http | typeof https,
    protocol: 'http:' | 'https:',
  ) => {
    const origRequest = mod.request;
    mod.request = function tappedRequest(
      ...args: Parameters<typeof mod.request>
    ): ReturnType<typeof mod.request> {
      const url = httpArgsToUrl(args as unknown[], protocol);
      if (touchesTelegram(url)) {
        logHttpCall(
          protocol === 'https:' ? 'https.request' : 'http.request',
          url,
          args as unknown[],
        );
      }
      // `apply` preserves the call-site thisArg (node:http passes the
      // module itself) without TS complaining about the parameter tuple.
      return (
        origRequest as (...a: unknown[]) => ReturnType<typeof mod.request>
      ).apply(mod, args as unknown[]);
    } as typeof mod.request;

    const origGet = mod.get;
    mod.get = function tappedGet(
      ...args: Parameters<typeof mod.get>
    ): ReturnType<typeof mod.get> {
      const url = httpArgsToUrl(args as unknown[], protocol);
      if (touchesTelegram(url)) {
        logHttpCall(
          protocol === 'https:' ? 'https.get' : 'http.get',
          url,
          args as unknown[],
        );
      }
      return (origGet as (...a: unknown[]) => ReturnType<typeof mod.get>).apply(
        mod,
        args as unknown[],
      );
    } as typeof mod.get;
  };
  wrapHttp(http, 'http:');
  wrapHttp(https, 'https:');

  logger.info(
    '[tg-tap] Outbound Telegram tap installed (fetch + http/https.request + http/https.get; ' +
      'child_process shell-outs via host-level ss watcher — see PR #92)',
  );
  return true;
}

// Snapshot originals at module load so reset can restore them cleanly.
// Captured here (not inside the function) so they aren't clobbered by
// a previous install's wrapper when reset is called after install.
const ORIG_FETCH = globalThis.fetch;
const ORIG_HTTP_REQUEST = http.request;
const ORIG_HTTPS_REQUEST = https.request;
const ORIG_HTTP_GET = http.get;
const ORIG_HTTPS_GET = https.get;

/**
 * Test-only reset hook. Restores the original `fetch`, `http.request`,
 * `https.request`, `http.get`, and `https.get` and clears the
 * `installed` flag so a subsequent `installTelegramOutboundTap()`
 * call can re-attach.
 *
 * Unit tests need this because the tap mutates five different globals
 * and otherwise one test's install would bleed into the next test's
 * assertions.
 *
 * @internal exported ONLY for `telegram-outbound-tap.test.ts`. Do not
 *   call from production code — the idempotent install path is the
 *   only surface application code should use.
 */
export function __resetTelegramOutboundTapForTests(): void {
  installed = false;
  globalThis.fetch = ORIG_FETCH;
  http.request = ORIG_HTTP_REQUEST;
  https.request = ORIG_HTTPS_REQUEST;
  http.get = ORIG_HTTP_GET;
  https.get = ORIG_HTTPS_GET;
}
