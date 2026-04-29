import fs from 'fs';
import path from 'path';

import { isExpectedFsError } from './fs-errors.js';
import { logger } from './logger.js';

/**
 * Filenames written by `GroupQueue.sendMessage`:
 *   `${Date.now()}-${random}.json`
 * The leading numeric segment is the millisecond timestamp at write time.
 * The matching `.tmp` form is the in-flight rename target — never touch
 * those, the writer is mid-`fs.renameSync`.
 *
 * Reserved names produced by the agent or the queue carry no numeric prefix
 * and must be preserved unconditionally:
 *   - `_close`           (queue → agent shutdown sentinel)
 *   - `_reply_to`        (agent → MCP reply-to handoff)
 *   - `_script_result_*` (agent script-result handoff to host)
 */
const SWEEPABLE_FILENAME_RE = /^(\d+)-[A-Za-z0-9]+\.json$/;

/**
 * Sweep stale `${ts}-${rand}.json` IPC inputs from a session input dir.
 *
 * Why this exists — see issue #287. Untrusted containers mount
 * `/workspace/ipc/input` read-only by design, so the agent-runner's
 * `drainIpcInput()` can't unlink files after consuming them (`EROFS`).
 * Without a host-side sweep the dir grows unbounded across container
 * restarts; the next fresh spawn re-drains the entire backlog into its
 * initial prompt and crosses the auto-compact threshold mid-query.
 *
 * Trusted containers self-clean (the unlink succeeds), but the same sweep
 * runs for them as a cheap defence-in-depth: if the agent's unlink ever
 * fails for an unrelated reason, the host will still GC.
 *
 * `graceMs` keeps the sweep from racing the agent's drain on currently-
 * active containers — only files older than `graceMs` are eligible. The
 * sole caller today is the pre-spawn site in `buildVolumeMounts`, which
 * passes `0` (no live agent to race). The parameter remains exposed
 * because any future caller that wants to GC during a container's
 * lifetime needs it; an earlier draft of #287 included a per-write
 * sweep with a 60s grace, dropped after Copilot review surfaced the
 * race against long-running queries that don't drain mid-flight.
 *
 * Returns the number of files unlinked. Expected best-effort filesystem
 * errnos (`isExpectedFsError`: ENOENT, EACCES, EBUSY, …) are logged and
 * absorbed so the sweep never blocks the message-delivery path on a
 * transient race. Any other error (TypeError from a programming bug, EIO
 * from hardware failure, anything else outside the allowlist) is
 * deliberately rethrown — the orchestrator must surface those at the
 * call site rather than have the sweep silently swallow a real bug.
 */
export function sweepStaleInputs(
  sessionInputDir: string,
  graceMs: number,
): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionInputDir);
  } catch (err) {
    if (!isExpectedFsError(err)) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    logger.warn(
      { err, sessionInputDir },
      'sweepStaleInputs: readdir failed, skipping sweep',
    );
    return 0;
  }

  const now = Date.now();
  const cutoff = now - graceMs;
  let removed = 0;

  for (const entry of entries) {
    const match = SWEEPABLE_FILENAME_RE.exec(entry);
    if (!match) continue;
    const writtenAtMs = Number(match[1]);
    if (!Number.isFinite(writtenAtMs)) continue;
    if (writtenAtMs > cutoff) continue;

    const filePath = path.join(sessionInputDir, entry);
    try {
      fs.unlinkSync(filePath);
      removed++;
    } catch (err) {
      if (!isExpectedFsError(err)) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT — already gone (agent or another sweep beat us). Benign.
      if (code === 'ENOENT') continue;
      logger.warn(
        { err, filePath },
        'sweepStaleInputs: unlink failed, leaving file in place',
      );
    }
  }

  if (removed > 0) {
    logger.debug(
      { sessionInputDir, removed, graceMs },
      'sweepStaleInputs: removed stale IPC inputs',
    );
  }
  return removed;
}
