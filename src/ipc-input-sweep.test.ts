import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { sweepStaleInputs } from './ipc-input-sweep.js';
import { logger } from './logger.js';

const TEST_ROOT = path.join(
  os.tmpdir(),
  `nanoclaw-sweep-test-${process.pid}-${Date.now()}`,
);

function makeSessionDir(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, name: string, content: string = '{}'): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

beforeEach(() => {
  // Fresh tree per test — every test owns its own subdir name so leftover
  // files from a previous (failed) run can't influence the next.
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.debug).mockClear();
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('sweepStaleInputs (#287 IPC backlog GC)', () => {
  it('returns 0 when the dir does not exist (first-spawn case)', () => {
    const removed = sweepStaleInputs(path.join(TEST_ROOT, 'nonexistent'), 0);
    expect(removed).toBe(0);
    // ENOENT is expected, not a real failure — must not warn.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('removes message files older than the grace window', () => {
    const dir = makeSessionDir('grace-window');
    const oldTs = Date.now() - 120_000; // 2 minutes ago
    const recentTs = Date.now() - 1_000; // 1 second ago
    const oldFile = writeFile(dir, `${oldTs}-abc1.json`);
    const recentFile = writeFile(dir, `${recentTs}-abc2.json`);

    const removed = sweepStaleInputs(dir, 60_000); // 60s grace

    expect(removed).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(recentFile)).toBe(true);
  });

  it('graceMs = 0 sweeps every message file regardless of age (pre-spawn)', () => {
    const dir = makeSessionDir('pre-spawn');
    const recentTs = Date.now();
    const oldTs = Date.now() - 86_400_000;
    writeFile(dir, `${recentTs}-aaaa.json`);
    writeFile(dir, `${oldTs}-bbbb.json`);

    const removed = sweepStaleInputs(dir, 0);

    expect(removed).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('preserves reserved IPC files (_close, _reply_to, _script_result_*)', () => {
    const dir = makeSessionDir('reserved');
    // Old enough that an age-based check would pick them up if regex was wrong
    const oldTs = Date.now() - 999_999_999;
    const closeFile = writeFile(dir, '_close', '');
    const replyToFile = writeFile(dir, '_reply_to', 'msg-123');
    const scriptResult = writeFile(
      dir,
      `_script_result_${oldTs}.json`,
      '{"ok":true}',
    );
    const sweepable = writeFile(dir, `${oldTs}-aaaa.json`);

    const removed = sweepStaleInputs(dir, 0);

    expect(removed).toBe(1);
    expect(fs.existsSync(closeFile)).toBe(true);
    expect(fs.existsSync(replyToFile)).toBe(true);
    expect(fs.existsSync(scriptResult)).toBe(true);
    expect(fs.existsSync(sweepable)).toBe(false);
  });

  it('skips in-flight `.tmp` writes (avoid racing fs.renameSync)', () => {
    const dir = makeSessionDir('tmp-files');
    const ts = Date.now() - 999_999_999;
    const tmp = writeFile(dir, `${ts}-aaaa.json.tmp`, '{}');

    const removed = sweepStaleInputs(dir, 0);

    expect(removed).toBe(0);
    expect(fs.existsSync(tmp)).toBe(true);
  });

  it('ignores files that do not match the timestamp-prefix pattern', () => {
    const dir = makeSessionDir('non-matching');
    // No leading digits — must not be touched.
    writeFile(dir, 'abc.json');
    writeFile(dir, 'manual-test.json');
    writeFile(dir, 'README');

    const removed = sweepStaleInputs(dir, 0);

    expect(removed).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual([
      'README',
      'abc.json',
      'manual-test.json',
    ]);
  });

  it('survives unlink races (ENOENT) without warning or aborting the sweep', () => {
    const dir = makeSessionDir('unlink-race');
    const ts = Date.now() - 999_999_999;
    const a = writeFile(dir, `${ts}-aaaa.json`);
    const b = writeFile(dir, `${ts + 1}-bbbb.json`);

    // Pre-delete `a` so the sweep's unlink will race-lose with ENOENT.
    // The sweep must still process `b` and not log a warning for the
    // ENOENT — that's a benign race, not a real failure.
    fs.unlinkSync(a);

    const removed = sweepStaleInputs(dir, 0);

    expect(removed).toBe(1); // only `b` actually unlinked
    expect(fs.existsSync(b)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
