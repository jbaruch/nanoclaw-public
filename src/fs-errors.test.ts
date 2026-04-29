import { describe, it, expect } from 'vitest';

import { isExpectedFsError } from './fs-errors.js';

function fsError(code: string): NodeJS.ErrnoException {
  const err = new Error(`mock ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('isExpectedFsError', () => {
  it('returns true for every code in the shared expected set', () => {
    // Pinned list — extending the set requires a deliberate change to
    // `fs-errors.ts` and (probably) a follow-up audit of every caller.
    const expected = [
      'EACCES',
      'EPERM',
      'ENOSPC',
      'EROFS',
      'ENOENT',
      'EISDIR',
      'EBUSY',
      'ENOTDIR',
      'EMFILE',
      'ENFILE',
      'ENAMETOOLONG',
    ];
    for (const code of expected) {
      expect(isExpectedFsError(fsError(code))).toBe(true);
    }
  });

  it('returns false for codes outside the expected set', () => {
    // EIO and EFAULT are real OS errnos but represent hardware /
    // kernel-level failures that the orchestrator must NOT swallow —
    // they indicate state we can't reason about. ETIMEDOUT is included
    // so a network-style error never falls through the fs filter.
    expect(isExpectedFsError(fsError('EIO'))).toBe(false);
    expect(isExpectedFsError(fsError('EFAULT'))).toBe(false);
    expect(isExpectedFsError(fsError('ETIMEDOUT'))).toBe(false);
  });

  it('returns false for an Error without a `.code` property (programmer error)', () => {
    // A plain `throw new Error("oops")` has no `.code` — treating it
    // as expected would silently swallow real bugs.
    expect(isExpectedFsError(new Error('oops'))).toBe(false);
  });

  it('returns false for non-Error throws (strings, numbers, objects)', () => {
    // Authors sometimes `throw "string"` or `throw { code: "EROFS" }`
    // — the helper requires an actual Error instance because the
    // caller's `catch (err: unknown)` block needs `err instanceof
    // Error` to narrow safely.
    expect(isExpectedFsError('EROFS')).toBe(false);
    expect(isExpectedFsError({ code: 'EROFS' })).toBe(false);
    expect(isExpectedFsError(42)).toBe(false);
    expect(isExpectedFsError(null)).toBe(false);
    expect(isExpectedFsError(undefined)).toBe(false);
  });

  it('returns false when `.code` is non-string (numeric errno from a native binding)', () => {
    // Some native bindings stamp a numeric `errno` rather than a
    // string `code`. The shared helper deliberately keys on the
    // string set; numeric errnos go through the rethrow path so the
    // mismatch surfaces.
    const err = new Error('numeric') as NodeJS.ErrnoException;
    (err as unknown as { code: number }).code = 13; // EACCES on Linux
    expect(isExpectedFsError(err)).toBe(false);
  });
});
