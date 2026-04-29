import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `runIpcGc` resolves paths under `DATA_DIR` from `./config.js`. Override
// `DATA_DIR` to a tmp dir per-test by mocking the module before importing
// the GC. vitest handles the timing — `vi.mock` is hoisted to the top of
// the file, but we need `tmpRoot` to be set before any test runs the GC,
// so we use a getter and stash the path in a `process.env` var.

let tmpRoot: string;

vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    get DATA_DIR() {
      return process.env.__IPC_GC_TEST_DATA_DIR || actual.DATA_DIR;
    },
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import { runIpcGc } from './ipc-gc.js';
import { logger } from './logger.js';

const GROUP = 'testgroup';

function ipcDir(): string {
  return path.join(tmpRoot, 'ipc', GROUP);
}

function writeLog(lines: string[]): void {
  const messagesDir = path.join(ipcDir(), 'messages');
  fs.mkdirSync(messagesDir, { recursive: true });
  fs.writeFileSync(
    path.join(messagesDir, '_consumed_inputs.log'),
    lines.join('\n') + '\n',
  );
}

function writeProcessing(lines: string[]): void {
  const messagesDir = path.join(ipcDir(), 'messages');
  fs.mkdirSync(messagesDir, { recursive: true });
  fs.writeFileSync(
    path.join(messagesDir, '_consumed_inputs.log.processing'),
    lines.join('\n') + '\n',
  );
}

function makeInputFile(sessionDir: string, name: string): string {
  const dir = path.join(ipcDir(), sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '{}');
  return p;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-gc-'));
  process.env.__IPC_GC_TEST_DATA_DIR = tmpRoot;
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.__IPC_GC_TEST_DATA_DIR;
});

describe('runIpcGc', () => {
  it('returns {0,0} and does not throw when log is missing', async () => {
    const result = await runIpcGc(GROUP);
    expect(result).toEqual({ deleted: 0, kept: 0 });
  });

  it('deletes a listed input file and cleans up .processing', async () => {
    const name = '1234567890-abcd.json';
    const inputPath = makeInputFile('input-default', name);
    writeLog([name]);

    const result = await runIpcGc(GROUP);

    // input-default → deleted; input-maintenance → ENOENT (kept).
    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(1);
    expect(fs.existsSync(inputPath)).toBe(false);
    expect(
      fs.existsSync(
        path.join(ipcDir(), 'messages', '_consumed_inputs.log.processing'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(ipcDir(), 'messages', '_consumed_inputs.log')),
    ).toBe(false);
  });

  it('also unlinks from input-maintenance when present', async () => {
    const name = '1234567890-mtnc.json';
    const a = makeInputFile('input-default', name);
    const b = makeInputFile('input-maintenance', name);
    writeLog([name]);

    const result = await runIpcGc(GROUP);

    expect(result.deleted).toBe(2);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
  });

  it('tolerates a listed file that is already gone (counts as kept)', async () => {
    writeLog(['1234567890-gone.json']);

    const result = await runIpcGc(GROUP);

    // Two session dirs scanned, both ENOENT
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(2);
    expect(
      fs.existsSync(
        path.join(ipcDir(), 'messages', '_consumed_inputs.log.processing'),
      ),
    ).toBe(false);
  });

  it('rejects path-traversal entries but processes safe ones in same log', async () => {
    const safe = '1700000000-aaaa.json';
    const safePath = makeInputFile('input-default', safe);
    writeLog(['../etc/passwd', 'foo/bar.json', '..\\windows.json', safe]);

    const result = await runIpcGc(GROUP);

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(safePath)).toBe(false);

    const warnCalls = (
      logger.warn as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const traversalWarnings = warnCalls.filter((args) => {
      const msg = args[1];
      return typeof msg === 'string' && msg.includes('IPC GC');
    });
    expect(traversalWarnings.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects entries that fail the basename allowlist (no .json suffix, weird chars)', async () => {
    writeLog(['not-json', '1234-abc.txt', 'has space.json', 'has$dollar.json']);

    const result = await runIpcGc(GROUP);

    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(0);
    // No safe entries → .processing is still cleaned up.
    expect(
      fs.existsSync(
        path.join(ipcDir(), 'messages', '_consumed_inputs.log.processing'),
      ),
    ).toBe(false);
  });

  it('picks up an existing .processing file without re-renaming', async () => {
    const leftover = '1700000000-prev.json';
    const leftoverPath = makeInputFile('input-default', leftover);
    writeProcessing([leftover]);

    // Also write a new .log — it should NOT be touched in this run.
    const fresh = '1700000001-fresh.json';
    makeInputFile('input-default', fresh);
    writeLog([fresh]);

    const result = await runIpcGc(GROUP);

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(leftoverPath)).toBe(false);
    // Fresh log untouched until next run.
    expect(
      fs.existsSync(path.join(ipcDir(), 'messages', '_consumed_inputs.log')),
    ).toBe(true);
    // Processing file consumed.
    expect(
      fs.existsSync(
        path.join(ipcDir(), 'messages', '_consumed_inputs.log.processing'),
      ),
    ).toBe(false);
  });

  it('dedupes duplicate basenames within a single log', async () => {
    const name = '1700000000-dup.json';
    const inputPath = makeInputFile('input-default', name);
    writeLog([name, name, name]);

    const result = await runIpcGc(GROUP);

    // First unlink succeeds; the dedupe means we only attempt input-default
    // and input-maintenance once. input-maintenance is ENOENT → kept=1.
    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(1);
    expect(fs.existsSync(inputPath)).toBe(false);
  });
});
