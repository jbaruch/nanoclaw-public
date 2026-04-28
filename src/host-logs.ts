import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

/**
 * Host log artifacts the admin tile reads via `/workspace/host-logs/`
 * (mounted read-only from this directory). Two sub-trees:
 *
 *   - `orchestrator.log`     — the orchestrator's own log lines, written
 *                              by `logger.ts` in addition to stdout/stderr.
 *                              Rotated to `.1` when it exceeds the size cap.
 *   - `containers/<folder>/<session>/<iso>.log`
 *                            — per-spawn streaming log of container
 *                              stdout/stderr, opened at spawn and closed
 *                              on exit. Distinct from the existing
 *                              post-exit summary at `groups/<folder>/logs/`.
 *
 * (A `state/snapshot.json` writer was contemplated for the issue's
 * "host-side state" deliverable but the existing `chat_status` MCP
 * tool already exposes the same data on demand. Adding a periodic
 * file writer would duplicate that data; the only marginal value is
 * reachability when the orchestrator is unresponsive, and the
 * recovery path for that scenario is `/scripts/deploy.sh` rather
 * than reading a snapshot file. Folded into the issue's followup if
 * the orchestrator-down case becomes load-bearing in practice.)
 *
 * Only the admin tile gets this directory mounted in. Untrusted / trusted /
 * core / host tiles must NOT receive it — these files are inherently
 * cross-chat (orchestrator log, all groups' container output, all groups'
 * state).
 *
 * Paths are exposed as getters (not module-level `const` strings) so
 * tests that mock `DATA_DIR` after this module is imported still see
 * the mocked value. A `const HOST_LOGS_DIR = path.join(DATA_DIR, ...)`
 * at module top would freeze whatever `DATA_DIR` resolved to at import
 * time — vi.mock factories run async, so the mock can land AFTER an
 * indirect import has already evaluated the const, leaving the test
 * with a path under the real (unmocked) DATA_DIR.
 *
 * The static `import { DATA_DIR } from './config.js'` here creates a
 * potential cycle (config → env → logger → host-logs → config); the
 * cycle is broken at env.ts which lazy-loads logger via require() so
 * env never completes via the import-of-logger path during the cycle.
 * See env.ts for the why.
 */
export function hostLogsDir(): string {
  return path.join(DATA_DIR, 'host-logs');
}
export function hostLogsContainersDir(): string {
  return path.join(hostLogsDir(), 'containers');
}
export function hostLogsStateDir(): string {
  return path.join(hostLogsDir(), 'state');
}
export function hostLogsOrchestratorFile(): string {
  return path.join(hostLogsDir(), 'orchestrator.log');
}

// Retention for per-container streaming logs. Long enough to cover a
// long weekend of debugging history; short enough that the directory
// can't fill the host's disk over months. Seven days is the same
// floor `scripts/logrotate.sh` lands on for the orchestrator log.
export const CONTAINER_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// 10 MB matches `scripts/logrotate.sh`'s rotation threshold for the
// orchestrator log file. Keep them in sync — the orchestrator and the
// rotation script agree on what "too big" means.
export const ORCHESTRATOR_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Best-effort directory bootstrap. Called from the orchestrator at
 * startup AND lazily by the logger (logger may run before the
 * orchestrator's startup hook on some import-order paths). Failure is
 * non-fatal — callers fall back to stdout-only logging or skip the
 * host-logs mount entirely.
 *
 * Returns `true` if all three directories exist after the call,
 * `false` if any mkdirSync failed (EACCES, EROFS, ENOSPC, etc.).
 * Each call is idempotent; failures don't half-complete state.
 */
export function ensureHostLogDirs(): boolean {
  // Wrap each mkdirSync individually so a failure on the second or
  // third doesn't unwind progress on the first (mkdir is idempotent
  // anyway, but we should still keep the partial-success state if it
  // helps later callers — e.g. the logger sink only needs the root
  // dir, not containers/ or state/).
  let ok = true;
  try {
    fs.mkdirSync(hostLogsDir(), { recursive: true });
  } catch {
    ok = false;
  }
  try {
    fs.mkdirSync(hostLogsContainersDir(), { recursive: true });
  } catch {
    ok = false;
  }
  try {
    fs.mkdirSync(hostLogsStateDir(), { recursive: true });
  } catch {
    ok = false;
  }
  return ok;
}

/**
 * Where the streaming log file for a single container spawn should live.
 * Caller passes the spawn timestamp explicitly so the filename is
 * tied to the spawn moment (millisecond precision), keeping per-spawn
 * files distinct under a high-spawn-rate operator workload.
 *
 * Note: this filename is currently NOT cross-referenced by the existing
 * post-exit summary writer at `groups/<folder>/logs/`. The summary uses
 * its own exit-time `new Date().toISOString()` and the two paths live
 * in different trees serving different audiences (host operator vs.
 * admin tile). If a future change wants symmetry, both writers should
 * accept the spawn timestamp from the caller and stamp the same
 * filename.
 */
export function containerLogPath(
  groupFolder: string,
  sessionName: string,
  startedAt: Date,
): string {
  // Replace `:` and `.` so the filename is portable across filesystems
  // (FAT32 / Windows shares occasionally appear in NAS scenarios).
  const safeTs = startedAt.toISOString().replace(/[:.]/g, '-');
  return path.join(
    hostLogsContainersDir(),
    groupFolder,
    sessionName,
    `${safeTs}.log`,
  );
}

/**
 * Walk the containers directory and delete `.log` files older than the
 * retention cutoff. Idempotent — safe to call repeatedly. Failure on a
 * single file is logged at the call site (this module doesn't import
 * the logger to keep its dep graph minimal — `logger` already imports
 * from this module's sibling `config`).
 *
 * Returns the count of deleted files for the caller to log.
 */
export function pruneOldContainerLogs(now: Date = new Date()): number {
  const containersDir = hostLogsContainersDir();
  if (!fs.existsSync(containersDir)) return 0;
  const cutoffMs = now.getTime() - CONTAINER_LOG_RETENTION_MS;
  let deleted = 0;
  // Two-level walk: containers/<folder>/<session>/<file>.log. We don't
  // want to recurse arbitrarily deep — the structure is fixed, and
  // reading every directory under DATA_DIR would be a footgun if a
  // future rename misplaced something.
  for (const folder of safeReaddir(containersDir)) {
    const folderPath = path.join(containersDir, folder);
    if (!safeIsDir(folderPath)) continue;
    for (const session of safeReaddir(folderPath)) {
      const sessionPath = path.join(folderPath, session);
      if (!safeIsDir(sessionPath)) continue;
      for (const file of safeReaddir(sessionPath)) {
        if (!file.endsWith('.log')) continue;
        const filePath = path.join(sessionPath, file);
        const stat = safeStat(filePath);
        if (!stat) continue;
        if (stat.mtimeMs < cutoffMs) {
          try {
            fs.unlinkSync(filePath);
            deleted++;
          } catch {
            // File raced with another prune or was renamed; skip.
          }
        }
      }
    }
  }
  return deleted;
}

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Strip ANSI escape sequences from a log line. The orchestrator's
 * console output is colorized for human reading, but the file sink and
 * snapshot consumers just want the text — colors render as garbled
 * `\x1b[33m` literals in tools that don't interpret them (most editors,
 * `cat` over SSH, the admin tile's file reads). Exported for the test
 * suite.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}
