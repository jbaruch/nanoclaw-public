/**
 * Tests for `parseHostId` validation in `config.ts` (issue #258).
 *
 * `HOST_UID` and `HOST_GID` are computed at module-load from
 * `process.env`. To exercise the validation paths we mutate the env
 * BEFORE each `vi.resetModules()` + dynamic `import('./config.js')`
 * so the fresh module evaluation sees the new value. The existing
 * `logger.test.ts` uses the same pattern for `LOG_LEVEL`.
 *
 * Stderr is captured via `vi.spyOn(process.stderr, 'write')` rather
 * than the logger because `config.ts` deliberately writes to stderr
 * directly — it sits below `logger.ts` in the import graph and a
 * `logger` import here would close a circular dep through
 * `host-logs.ts`. The exact constraint is documented in `config.ts`.
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

async function loadConfig(): Promise<typeof import('./config.js')> {
  vi.resetModules();
  return await import('./config.js');
}

describe('HOST_UID / HOST_GID parsing', () => {
  it('returns undefined and emits no warning when env is unset', async () => {
    const { HOST_UID, HOST_GID } = await loadConfig();
    expect(HOST_UID).toBeUndefined();
    expect(HOST_GID).toBeUndefined();
    expect(stderrWrites.some((line) => line.includes('HOST_UID'))).toBe(false);
    expect(stderrWrites.some((line) => line.includes('HOST_GID'))).toBe(false);
  });

  it('parses a positive integer string into a number', async () => {
    process.env.HOST_UID = '999';
    process.env.HOST_GID = '1001';
    const { HOST_UID, HOST_GID } = await loadConfig();
    expect(HOST_UID).toBe(999);
    expect(HOST_GID).toBe(1001);
    expect(stderrWrites.some((line) => line.includes('HOST_UID'))).toBe(false);
  });

  it('accepts zero (in-container root case)', async () => {
    process.env.HOST_UID = '0';
    process.env.HOST_GID = '0';
    const { HOST_UID, HOST_GID } = await loadConfig();
    // Zero is a legitimate uid (root) — must not be confused with
    // "missing" by the validator. Downstream sites guard against
    // chowning to root explicitly; that's their job, not config's.
    expect(HOST_UID).toBe(0);
    expect(HOST_GID).toBe(0);
    expect(stderrWrites.join('')).not.toMatch(/HOST_UID|HOST_GID/);
  });

  it('warns and returns undefined when HOST_UID is non-numeric (NaN guard)', async () => {
    process.env.HOST_UID = 'foo';
    const { HOST_UID } = await loadConfig();
    expect(HOST_UID).toBeUndefined();
    const warning = stderrWrites.find((line) => line.includes('HOST_UID'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"foo"');
    expect(warning).toContain('non-negative integer');
  });

  it('warns and returns undefined when HOST_UID is negative', async () => {
    process.env.HOST_UID = '-1';
    const { HOST_UID } = await loadConfig();
    expect(HOST_UID).toBeUndefined();
    const warning = stderrWrites.find((line) => line.includes('HOST_UID'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"-1"');
  });

  it('warns and returns undefined when HOST_GID is malformed', async () => {
    // Symmetric coverage — same helper handles both names, but a typo
    // in the GID branch (wrong env-var name passed to the helper)
    // would otherwise pass with only a HOST_UID test.
    process.env.HOST_GID = 'bar';
    const { HOST_GID } = await loadConfig();
    expect(HOST_GID).toBeUndefined();
    const warning = stderrWrites.find((line) => line.includes('HOST_GID'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"bar"');
  });

  it('warns independently for each malformed variable', async () => {
    process.env.HOST_UID = 'foo';
    process.env.HOST_GID = '-5';
    const { HOST_UID, HOST_GID } = await loadConfig();
    expect(HOST_UID).toBeUndefined();
    expect(HOST_GID).toBeUndefined();
    const joined = stderrWrites.join('');
    expect(joined).toContain('HOST_UID="foo"');
    expect(joined).toContain('HOST_GID="-5"');
  });
});
