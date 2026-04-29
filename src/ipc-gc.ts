/**
 * Host-side IPC garbage collector. Issue #47.
 *
 * Untrusted-tier containers mount `data/ipc/<group>/input/` read-only as a
 * security boundary (a compromised agent must not be able to forge user
 * input or plant a `_close` sentinel). The agent's `unlinkSync` therefore
 * fails with `EROFS` and the consumed JSON files stay on disk. Without GC,
 * the dir grows without bound and every fresh container re-drains the
 * lifetime backlog as one initial prompt — see issue #47 for the wtf-group
 * incident that motivated this.
 *
 * Protocol (matches `container/agent-runner/src/index.ts`):
 *   1. Agent appends consumed input basenames (one per line) to
 *      `messages/_consumed_inputs.log` after each successful drain.
 *      `messages/` is RW for both trusted and untrusted containers.
 *   2. This GC atomically renames the log to `_consumed_inputs.log.processing`
 *      so a concurrent agent append doesn't see a half-deleted set.
 *   3. For each line, unlink the matching file in
 *      `input-default/` and `input-maintenance/` (the two session input dirs
 *      a group can have — see `sessionInputDirName` in `container-runner.ts`).
 *   4. On success, delete `.processing`. On error, leave it for the next run
 *      so we eventually clean up.
 *
 * Crash recovery: if the process dies mid-GC, the next call picks up the
 * leftover `.processing` file (no re-rename — that would clobber any new
 * appends to a freshly-created `.log`).
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Allowlist for input basenames listed in the consumed log. Mirrors the
 * shape produced by `group-queue.ts` (`${Date.now()}-${rand}.json`) and the
 * MCP stdio writer in `ipc-mcp-stdio.ts` (`${Date.now()}-${rand}.json`).
 *
 * The strict allowlist exists to defend against an agent that, accidentally
 * or maliciously, writes a path-traversal entry into the consumed log
 * (e.g. `../../etc/passwd`) hoping to trick the GC into deleting an
 * arbitrary host file. We refuse anything containing `/`, `\`, or `..`,
 * and also enforce a positive character class so weird shell metacharacters
 * (`$`, backticks, newlines, etc.) can't slip through.
 */
const VALID_INPUT_BASENAME_RE = /^[A-Za-z0-9_.-]+\.json$/;

/**
 * Same shape as `sessionInputDirName('default'|'maintenance')` in
 * container-runner.ts — duplicated here to avoid a cross-module import that
 * would otherwise be circular at startup.
 */
const SESSION_INPUT_DIRS = ['input-default', 'input-maintenance'] as const;

const CONSUMED_LOG_NAME = '_consumed_inputs.log';
const PROCESSING_NAME = `${CONSUMED_LOG_NAME}.processing`;

export interface IpcGcResult {
  /** Number of input files successfully unlinked. */
  deleted: number;
  /** Number of log lines that pointed at files that were already gone (ENOENT). */
  kept: number;
}

/**
 * Run one GC pass for a single group. Safe to call repeatedly. Returns
 * counts but never throws to the caller — internal errors are logged so the
 * scheduler doesn't crash the orchestrator on a transient FS hiccup.
 */
export async function runIpcGc(groupFolder: string): Promise<IpcGcResult> {
  const messagesDir = path.join(DATA_DIR, 'ipc', groupFolder, 'messages');
  const logPath = path.join(messagesDir, CONSUMED_LOG_NAME);
  const processingPath = path.join(messagesDir, PROCESSING_NAME);

  // Pick up a leftover from a prior crashed/interrupted GC first. If both
  // files exist, we drop the new `.log` until the next run — handling them
  // sequentially is simpler than merging, and the next call (60s later)
  // will catch it.
  let processingExists: boolean;
  try {
    fs.statSync(processingPath);
    processingExists = true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      processingExists = false;
    } else {
      throw e;
    }
  }

  if (!processingExists) {
    // Nothing pending; promote any new log to .processing.
    try {
      fs.renameSync(logPath, processingPath);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // No log written yet (first run, or quiet group). Nothing to do.
        return { deleted: 0, kept: 0 };
      }
      throw e;
    }
  }

  // Read the .processing file (whether it was just renamed or left over).
  const raw = fs.readFileSync(processingPath, 'utf-8');
  const seen = new Set<string>();
  let deleted = 0;
  let kept = 0;
  let skipped = 0;

  for (const line of raw.split('\n')) {
    const name = line.trim();
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      logger.warn(
        { groupFolder, entry: name },
        'IPC GC: refusing path-traversal entry in consumed log',
      );
      skipped++;
      continue;
    }
    if (!VALID_INPUT_BASENAME_RE.test(name)) {
      logger.warn(
        { groupFolder, entry: name },
        'IPC GC: refusing non-allowlist entry in consumed log',
      );
      skipped++;
      continue;
    }

    for (const sessionDir of SESSION_INPUT_DIRS) {
      const target = path.join(DATA_DIR, 'ipc', groupFolder, sessionDir, name);
      try {
        fs.unlinkSync(target);
        deleted++;
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // Already gone (host cursor advanced past it long ago, or another
          // GC pass beat us to it). Counted as "kept" only in the sense
          // that nothing got deleted; not an error.
          kept++;
          continue;
        }
        throw e;
      }
    }
  }

  // All deletions succeeded — drop the .processing file. If anything threw
  // above we re-raise to the caller, leaving .processing in place so the
  // next invocation retries.
  fs.unlinkSync(processingPath);

  if (deleted > 0 || skipped > 0) {
    logger.info(
      { groupFolder, deleted, kept, skipped },
      'IPC GC: processed consumed-inputs log',
    );
  }

  return { deleted, kept };
}

/**
 * Wrap `runIpcGc` so callers can fire-and-forget on a timer without
 * worrying about a thrown error tearing down the orchestrator.
 */
export async function runIpcGcSafe(groupFolder: string): Promise<void> {
  try {
    await runIpcGc(groupFolder);
  } catch (err) {
    logger.warn(
      { groupFolder, err },
      'IPC GC failed for group — leaving .processing file for retry',
    );
  }
}
