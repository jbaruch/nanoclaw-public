/**
 * Tests for the agent-runner's stale-session detector. Mirrors the
 * orchestrator-side suite at `src/stale-session.test.ts` exactly — the
 * same canonical input strings are asserted in both packages, so a
 * regex drift between them surfaces as a test failure.
 *
 * Coverage rationale matches `src/stale-session.test.ts`: locks in
 * the historical thrown-error phrasings (`no conversation found`,
 * `ENOENT`-on-JSONL, `session ... not found`), the `error_during_execution`
 * SDK result-message subtype #144 broadened in, the case-insensitive
 * flag, and the negative cases that must NOT match (model_error, OAuth
 * failures, etc.).
 */

import { describe, it, expect } from 'vitest';

import { isStaleSessionError } from './stale-session.js';

describe('isStaleSessionError (agent-runner)', () => {
  it('matches the historical "no conversation found" thrown error', () => {
    expect(
      isStaleSessionError(
        'Error: no conversation found for session 090b2cf8-...',
      ),
    ).toBe(true);
  });

  it('matches the JSONL-ENOENT shape from a missing transcript file', () => {
    expect(
      isStaleSessionError(
        'ENOENT: no such file or directory, open ' +
          '/workspace/.claude/projects/-workspace-group/090b2cf8.jsonl',
      ),
    ).toBe(true);
  });

  it('matches "session ... not found" / "session not found" wording', () => {
    expect(isStaleSessionError('SDKError: session 090b2cf8 not found')).toBe(
      true,
    );
    expect(isStaleSessionError('session not found')).toBe(true);
  });

  it('matches the SDK error_during_execution subtype (#144 bug 2)', () => {
    expect(
      isStaleSessionError(
        'error_during_execution: SDK aborted mid-turn, terminal_reason=model_error',
      ),
    ).toBe(true);
  });

  it('case-insensitive match', () => {
    // The /i flag is load-bearing — if a future SDK version emits
    // `Error_During_Execution` or all-caps, the throw-retry path must
    // still trigger fresh-session recovery rather than bubble the
    // exception up.
    expect(isStaleSessionError('ERROR_DURING_EXECUTION: foo')).toBe(true);
    expect(isStaleSessionError('Session Not Found')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    // Negative coverage — the predicate must not greedy-match. A
    // generic mid-turn SDK failure (rate limit, model error) is
    // probably recoverable on retry; clearing the sessionId would
    // throw away the in-flight conversation for no reason.
    expect(isStaleSessionError('Connection refused')).toBe(false);
    expect(isStaleSessionError('rate limited')).toBe(false);
    expect(isStaleSessionError('model_error: prompt too long')).toBe(false);
    expect(isStaleSessionError('OAuth token expired')).toBe(false);
  });

  it('returns false for empty / undefined input', () => {
    expect(isStaleSessionError(undefined)).toBe(false);
    expect(isStaleSessionError('')).toBe(false);
  });

  it('matches when the trigger token is anywhere in the message', () => {
    expect(
      isStaleSessionError(
        '[2026-04-26T18:50:00] container exited with code 1: ' +
          'error_during_execution: model produced empty response',
      ),
    ).toBe(true);
  });
});
