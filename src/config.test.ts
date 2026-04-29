/**
 * Tests for `parseHostId` validation in `config.ts` (issue #258).
 *
 * The helper is exported so tests can call it directly with mutated
 * `process.env`. The earlier draft used `vi.resetModules()` + dynamic
 * `import('./config.js')` to exercise the module-level `HOST_UID` /
 * `HOST_GID` exports — but that re-evaluates `logger.ts` on every
 * pass, and `logger.ts` registers a `process.on('uncaughtException')`
 * + `unhandledRejection` listener at the top level. Ten cases meant
 * ~20 stacked listeners and a `MaxListenersExceededWarning`. Calling
 * `parseHostId` directly with a fixed name argument is equivalent
 * coverage of the validation contract without the leak.
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

import { parseHostId } from './config.js';

const ORIGINAL_HOST_UID = process.env.HOST_UID;
const ORIGINAL_HOST_GID = process.env.HOST_GID;

let stderrSpy: ReturnType<typeof vi.spyOn>;
let stderrWrites: string[];

beforeEach(() => {
  stderrWrites = [];
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
  delete process.env.HOST_UID;
  delete process.env.HOST_GID;
});

afterEach(() => {
  stderrSpy.mockRestore();
});

afterAll(() => {
  if (ORIGINAL_HOST_UID === undefined) {
    delete process.env.HOST_UID;
  } else {
    process.env.HOST_UID = ORIGINAL_HOST_UID;
  }
  if (ORIGINAL_HOST_GID === undefined) {
    delete process.env.HOST_GID;
  } else {
    process.env.HOST_GID = ORIGINAL_HOST_GID;
  }
});

describe('parseHostId', () => {
  it('returns undefined and emits no warning when env is unset', () => {
    expect(parseHostId('HOST_UID')).toBeUndefined();
    expect(parseHostId('HOST_GID')).toBeUndefined();
    expect(stderrWrites.join('')).toBe('');
  });

  it('parses a positive integer string into a number', () => {
    process.env.HOST_UID = '999';
    process.env.HOST_GID = '1001';
    expect(parseHostId('HOST_UID')).toBe(999);
    expect(parseHostId('HOST_GID')).toBe(1001);
    expect(stderrWrites.join('')).toBe('');
  });

  it('accepts zero (in-container root case)', () => {
    // Zero is a legitimate uid (root) — must not be confused with
    // "missing" by the validator. Downstream sites guard against
    // chowning to root explicitly; that's their job, not config's.
    process.env.HOST_UID = '0';
    process.env.HOST_GID = '0';
    expect(parseHostId('HOST_UID')).toBe(0);
    expect(parseHostId('HOST_GID')).toBe(0);
    expect(stderrWrites.join('')).toBe('');
  });

  it('warns and returns undefined when value is non-numeric (NaN guard)', () => {
    process.env.HOST_UID = 'foo';
    expect(parseHostId('HOST_UID')).toBeUndefined();
    const warning = stderrWrites.find((line) => line.includes('HOST_UID'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"foo"');
    expect(warning).toContain('non-negative integer');
  });

  it('warns and returns undefined when value is negative', () => {
    process.env.HOST_UID = '-1';
    expect(parseHostId('HOST_UID')).toBeUndefined();
    const warning = stderrWrites.find((line) => line.includes('HOST_UID'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"-1"');
  });

  it('warns and returns undefined for partial-numeric input (parseInt trap)', () => {
    // `parseInt("123abc", 10)` returns 123 — a permissive partial
    // parse that would silently accept operator typos. The strict
    // digits-only regex rejects it.
    process.env.HOST_UID = '123abc';
    expect(parseHostId('HOST_UID')).toBeUndefined();
    const warning = stderrWrites.find((line) => line.includes('HOST_UID'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"123abc"');
  });

  it('warns and returns undefined for fractional input (parseInt trap)', () => {
    // `parseInt("1.5", 10)` returns 1 — same partial-parse hazard.
    process.env.HOST_GID = '1.5';
    expect(parseHostId('HOST_GID')).toBeUndefined();
    const warning = stderrWrites.find((line) => line.includes('HOST_GID'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"1.5"');
  });

  it('warns and returns undefined when env is set to empty string', () => {
    // An explicitly-set empty string (a `.env` line that lost its
    // value, e.g. `HOST_UID=`) is an operator typo, not a deliberate
    // "unset" — surface it the same way as any other malformed value.
    process.env.HOST_UID = '';
    expect(parseHostId('HOST_UID')).toBeUndefined();
    const warning = stderrWrites.find((line) => line.includes('HOST_UID'));
    expect(warning).toBeDefined();
    expect(warning).toContain('HOST_UID=""');
  });

  it('uses the name argument verbatim in the warning (HOST_GID branch)', () => {
    // Symmetric coverage — same helper handles both names, but a typo
    // in the GID branch (wrong env-var name passed to the helper)
    // would otherwise pass with only a HOST_UID test.
    process.env.HOST_GID = 'bar';
    expect(parseHostId('HOST_GID')).toBeUndefined();
    const warning = stderrWrites.find((line) => line.includes('HOST_GID'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"bar"');
  });

  it('warns independently when both variables are malformed', () => {
    process.env.HOST_UID = 'foo';
    process.env.HOST_GID = '-5';
    expect(parseHostId('HOST_UID')).toBeUndefined();
    expect(parseHostId('HOST_GID')).toBeUndefined();
    const joined = stderrWrites.join('');
    expect(joined).toContain('HOST_UID="foo"');
    expect(joined).toContain('HOST_GID="-5"');
  });
});
