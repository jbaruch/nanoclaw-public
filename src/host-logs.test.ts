import fs from 'fs';
import path from 'path';

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';

// Same TEST_DATA_DIR isolation pattern as ipc-auth.test.ts: host-logs
// derives every path from `DATA_DIR`. Mock the export so tests don't
// touch the developer's real `data/host-logs/` tree.
const { TEST_DATA_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osMod = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require('path') as typeof import('path');
  return {
    TEST_DATA_DIR: pathMod.join(
      osMod.tmpdir(),
      `nanoclaw-host-logs-test-${process.pid}`,
    ),
  };
});
vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DATA_DIR,
  };
});

import {
  CONTAINER_LOG_RETENTION_MS,
  containerLogPath,
  ensureHostLogDirs,
  hostLogsContainersDir,
  hostLogsDir,
  hostLogsStateDir,
  pruneOldContainerLogs,
  stripAnsi,
} from './host-logs.js';

beforeEach(() => {
  // Wipe between tests so dir-creation and prune assertions start
  // from a known-empty state. Don't blanket-rm TEST_DATA_DIR — other
  // mocked-config consumers (none today, but defensive) might share it.
  if (fs.existsSync(hostLogsDir())) {
    fs.rmSync(hostLogsDir(), { recursive: true, force: true });
  }
});

afterEach(() => {
  if (fs.existsSync(hostLogsDir())) {
    fs.rmSync(hostLogsDir(), { recursive: true, force: true });
  }
});

afterAll(() => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

// --- Path derivation ---

describe('host-logs paths', () => {
  it('places host-logs dir under DATA_DIR', () => {
    expect(hostLogsDir()).toBe(path.join(TEST_DATA_DIR, 'host-logs'));
    expect(hostLogsContainersDir()).toBe(
      path.join(hostLogsDir(), 'containers'),
    );
    expect(hostLogsStateDir()).toBe(path.join(hostLogsDir(), 'state'));
  });

  it('builds containerLogPath under containers/<folder>/<session>/', () => {
    const ts = new Date('2026-04-25T11:26:00.000Z');
    const p = containerLogPath('group_x', 'default', ts);
    expect(p).toBe(
      path.join(
        hostLogsContainersDir(),
        'group_x',
        'default',
        '2026-04-25T11-26-00-000Z.log',
      ),
    );
  });

  it('escapes filesystem-unfriendly characters in the timestamp', () => {
    // FAT32 / Windows shares occasionally appear in NAS scenarios —
    // colons and dots in filenames break those filesystems. The
    // helper must replace both. Without the replace, the file path
    // would be `2026-04-25T11:26:00.000Z.log`.
    const ts = new Date('2026-04-25T11:26:00.000Z');
    const p = containerLogPath('group_x', 'default', ts);
    expect(p).not.toContain(':');
    // The filename portion contains `2026-04-25T11-26-00-000Z`; the
    // `.log` extension at the end has the only dot in the basename.
    const fname = path.basename(p);
    expect(fname.match(/\./g)).toEqual(['.']);
  });
});

// --- Directory bootstrap ---

describe('ensureHostLogDirs', () => {
  it('creates the host-logs tree under DATA_DIR', () => {
    expect(fs.existsSync(hostLogsDir())).toBe(false);
    ensureHostLogDirs();
    expect(fs.existsSync(hostLogsDir())).toBe(true);
    expect(fs.existsSync(hostLogsContainersDir())).toBe(true);
    expect(fs.existsSync(hostLogsStateDir())).toBe(true);
  });

  it('is idempotent — second call on an already-populated tree does not throw', () => {
    ensureHostLogDirs();
    // Drop a sentinel inside containers/ so we can assert it survives
    // a redundant ensureHostLogDirs call.
    const sentinel = path.join(hostLogsContainersDir(), 'sentinel.txt');
    fs.writeFileSync(sentinel, 'still here');
    expect(() => ensureHostLogDirs()).not.toThrow();
    expect(fs.readFileSync(sentinel, 'utf-8')).toBe('still here');
  });

  it('returns true on success', () => {
    expect(ensureHostLogDirs()).toBe(true);
  });

  it('returns false when mkdirSync fails — never throws', () => {
    // Simulate a hostile filesystem (read-only mount, EACCES, etc.).
    // The orchestrator startup code path needs ensureHostLogDirs to
    // be best-effort: a failing dir-create must not crash spawn,
    // because aborting container creation on a logging-side failure
    // would mean no agent runs at all rather than just no host-logs
    // visibility — a strict downgrade of behaviour.
    const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('EROFS');
    });
    expect(() => ensureHostLogDirs()).not.toThrow();
    expect(ensureHostLogDirs()).toBe(false);
    spy.mockRestore();
  });
});

// --- Retention pruning ---

describe('pruneOldContainerLogs', () => {
  it('returns 0 when the containers directory does not exist', () => {
    expect(pruneOldContainerLogs(new Date())).toBe(0);
  });

  it('deletes only files older than the retention cutoff', () => {
    ensureHostLogDirs();
    const sessionDir = path.join(hostLogsContainersDir(), 'group_a', 'default');
    fs.mkdirSync(sessionDir, { recursive: true });
    const oldFile = path.join(sessionDir, 'old.log');
    const freshFile = path.join(sessionDir, 'fresh.log');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(freshFile, 'fresh');

    const now = new Date();
    // Make `oldFile` older than the retention window. `+1000` extra
    // ms is paranoia against subsecond clock drift between the
    // `now` we pass in and the file's mtimeMs comparison.
    const oldMtime = (now.getTime() - CONTAINER_LOG_RETENTION_MS - 1000) / 1000;
    fs.utimesSync(oldFile, oldMtime, oldMtime);

    const deleted = pruneOldContainerLogs(now);
    expect(deleted).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it('walks multiple groups and sessions, only touching .log files', () => {
    ensureHostLogDirs();
    const cutoffPast =
      (Date.now() - CONTAINER_LOG_RETENTION_MS - 60_000) / 1000;

    // Two groups, each with both default and maintenance sessions.
    // Drop a non-`.log` file in one to confirm it's left alone.
    for (const group of ['g1', 'g2']) {
      for (const session of ['default', 'maintenance']) {
        const dir = path.join(hostLogsContainersDir(), group, session);
        fs.mkdirSync(dir, { recursive: true });
        const old = path.join(dir, 'a.log');
        fs.writeFileSync(old, '');
        fs.utimesSync(old, cutoffPast, cutoffPast);
      }
    }
    const stray = path.join(
      hostLogsContainersDir(),
      'g1',
      'default',
      'README.md',
    );
    fs.writeFileSync(stray, 'not a log');
    fs.utimesSync(stray, cutoffPast, cutoffPast);

    const deleted = pruneOldContainerLogs();
    // 2 groups * 2 sessions = 4 .log files, all old. README is not .log.
    expect(deleted).toBe(4);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('ignores non-directory entries at the group level (defensive)', () => {
    ensureHostLogDirs();
    // A stray file directly under containers/ shouldn't crash the
    // walk. Write one and then run prune — should return 0 and not
    // throw. Models a future where some unrelated artifact lands in
    // the dir; the prune walk shouldn't cascade into it.
    const stray = path.join(hostLogsContainersDir(), 'oops.txt');
    fs.writeFileSync(stray, 'stray');
    expect(() => pruneOldContainerLogs()).not.toThrow();
    expect(fs.existsSync(stray)).toBe(true);
  });
});

// --- ANSI stripping ---

describe('stripAnsi', () => {
  it('removes color escape sequences', () => {
    const colored = '\x1b[31mred\x1b[0m text \x1b[1;32mbold green\x1b[39m';
    expect(stripAnsi(colored)).toBe('red text bold green');
  });

  it('passes plain text through unchanged', () => {
    expect(stripAnsi('plain log line')).toBe('plain log line');
  });

  it('handles empty input', () => {
    expect(stripAnsi('')).toBe('');
  });
});
