/**
 * Tests for the stale-session detector that drives the orchestrator's
 * "clear sessionId after agent error" recovery path. Imported as a
 * named export from `src/index.ts` so the regex is exercised by the
 * actual production predicate, not a duplicate.
 *
 * The recovery is the only way out of the wedge the #144 bug pair
 * created — once a sessionId points at a missing JSONL (because nuke
 * wiped the file but the completion handler resurrected the DB row),
 * every subsequent SDK call returns `error_during_execution` until
 * something clears the row. Before #144, the regex only matched
 * three thrown-error phrasings and missed the SDK's
 * `error_during_execution` result-message shape entirely. This test
 * suite locks in the expanded match set and the previously-covered
 * cases, so a future regex tweak can't silently re-introduce the
 * wedge.
 */

import { describe, it, expect } from 'vitest';

import { isStaleSessionError } from './index.js';

describe('isStaleSessionError', () => {
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
    // The agent-runner formats result-message errors as
    // `<subtype>: <summary>` (per #149's recovery path). The
    // previous regex missed `error_during_execution` entirely —
    // that miss is why every nuke-resurrected sessionId wedged the
    // chat instead of getting cleared on the next failed retry.
    expect(
      isStaleSessionError(
        'error_during_execution: SDK aborted mid-turn, terminal_reason=model_error',
      ),
    ).toBe(true);
  });

  it('case-insensitive match', () => {
    // The /i flag is load-bearing — if a future SDK version emits
    // `Error_During_Execution` or all-caps, we still need the
    // wedge-recovery to trigger.
    expect(isStaleSessionError('ERROR_DURING_EXECUTION: foo')).toBe(true);
    expect(isStaleSessionError('Session Not Found')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    // Negative coverage — the predicate must not greedy-match. A
    // generic "model_error" without `error_during_execution` is a
    // mid-turn SDK failure that the session can probably recover
    // from on retry; clearing the sessionId in that case would lose
    // the conversation for no reason.
    expect(isStaleSessionError('Connection refused')).toBe(false);
    expect(isStaleSessionError('rate limited')).toBe(false);
    expect(isStaleSessionError('model_error: prompt too long')).toBe(false);
    expect(isStaleSessionError('OAuth token expired')).toBe(false);
  });

  it('returns false for empty / undefined input', () => {
    // The wedge-recovery only fires when there's both a sessionId
    // AND an error to evaluate; the predicate must short-circuit
    // safely on missing input.
    expect(isStaleSessionError(undefined)).toBe(false);
    expect(isStaleSessionError('')).toBe(false);
  });

  it('matches when the trigger token is anywhere in the message', () => {
    // Real error strings carry context before/after the meaningful
    // token. The predicate must not require the token to be at a
    // particular position.
    expect(
      isStaleSessionError(
        '[2026-04-26T18:50:00] container exited with code 1: ' +
          'error_during_execution: model produced empty response',
      ),
    ).toBe(true);
  });
});
