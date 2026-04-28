/**
 * session-start-context — pure helpers for the
 * `session-start-auto-context` SessionStart hook (#141).
 *
 * Every container session needs three things in context to be useful:
 * `MEMORY.md` (auto-memory index), `RUNBOOK.md` (operational state),
 * and the most-recent daily log. Today this happens via the
 * `tessl__trusted-memory` skill, but skills are invoked on demand and
 * the model decides when. Under load or in a fast-turnaround session
 * it skips the read, and context starts empty.
 *
 * The hook makes the read deterministic and free: it composes the
 * three files into a single `additionalContext` block before the
 * agent's first turn fires. Pure file reads, no LLM round-trip.
 *
 * This module is the pure composer. The wiring half lives in
 * `index.ts` (`createSessionStartAutoContextHook`).
 */

import fs from 'fs';
import path from 'path';

export interface AutoContextPaths {
  /**
   * Absolute path to MEMORY.md inside the container's mounted
   * Claude project dir. Today the orchestrator mounts it at
   * `/home/node/.claude/projects/-workspace-group/memory/MEMORY.md`,
   * but the path is supplied by the caller so the helper stays
   * filesystem-shape-agnostic.
   */
  memoryFile: string;
  /**
   * Absolute path to the per-group RUNBOOK.md.
   */
  runbookFile: string;
  /**
   * Absolute path to the daily-log directory; the helper picks the
   * most-recent `<YYYY-MM-DD>.md` file inside it.
   */
  dailyLogDir: string;
  /**
   * Optional ceiling on the bytes injected per file. Truncates with a
   * `[truncated]` marker when exceeded. Default 32 KiB per file.
   */
  perFileMaxBytes?: number;
}

export interface AutoContextSection {
  /** Short label surfaced in the composed block header. */
  label: string;
  /** Source path for diagnostics + the in-block "from <path>" line. */
  sourcePath: string;
  /** Section body (already truncated if needed). */
  body: string;
  /** True iff the file existed and was read. */
  found: boolean;
}

export interface AutoContextResult {
  /**
   * The full composed text to hand to the SDK as `additionalContext`.
   * Empty string when no section was found — caller treats that as
   * "skip the inject".
   */
  composed: string;
  /** Per-section breakdown for logging. */
  sections: AutoContextSection[];
}

const DEFAULT_PER_FILE_MAX_BYTES = 32 * 1024;
const TRUNCATE_MARKER = '\n\n[truncated by session-start-auto-context]';

/**
 * Compose the auto-context block from MEMORY.md, RUNBOOK.md, and the
 * most-recent daily log. Missing files are silently skipped (logged
 * as `found: false` so the caller can surface the gap).
 */
export function composeAutoContext(paths: AutoContextPaths): AutoContextResult {
  const cap = paths.perFileMaxBytes ?? DEFAULT_PER_FILE_MAX_BYTES;
  const sections: AutoContextSection[] = [];
  sections.push(loadFileSection('MEMORY', paths.memoryFile, cap));
  sections.push(loadFileSection('RUNBOOK', paths.runbookFile, cap));
  sections.push(loadDailyLogSection(paths.dailyLogDir, cap));

  const present = sections.filter((s) => s.found);
  if (present.length === 0) {
    return { composed: '', sections };
  }
  const blocks = present.map(
    (s) =>
      `<auto-context section="${s.label}" source="${s.sourcePath}">\n${s.body}\n</auto-context>`,
  );
  return {
    composed: blocks.join('\n\n'),
    sections,
  };
}

/**
 * Allow-list of filesystem error codes the auto-context loaders fall
 * back on. Any other code (EBUSY, EIO, EMFILE, EROFS, …) is an
 * unexpected runtime fault that should NOT be masked as "file
 * missing"; let those propagate so they surface in the SDK error
 * channel rather than vanishing into a silent "no MEMORY available"
 * state.
 *
 *  - `ENOENT` — race with file rotation between `existsSync` and
 *    the read.
 *  - `EACCES` / `EPERM` — permission flap on a remount; common when
 *    bind-mounts are toggled by the orchestrator mid-session.
 *  - `ENOTDIR` — a parent path swapped from dir to file (rare but
 *    benign for our purposes).
 */
const EXPECTED_READ_ERROR_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOTDIR',
]);

function isExpectedReadError(err: unknown): boolean {
  const errno = err as NodeJS.ErrnoException | null | undefined;
  return (
    typeof errno?.code === 'string' &&
    EXPECTED_READ_ERROR_CODES.has(errno.code)
  );
}

function loadFileSection(
  label: string,
  filePath: string,
  cap: number,
): AutoContextSection {
  if (!fs.existsSync(filePath)) {
    return { label, sourcePath: filePath, body: '', found: false };
  }
  let body: string;
  try {
    body = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (!isExpectedReadError(err)) {
      throw err;
    }
    return { label, sourcePath: filePath, body: '', found: false };
  }
  return {
    label,
    sourcePath: filePath,
    body: truncate(body, cap),
    found: true,
  };
}

function loadDailyLogSection(
  dailyLogDir: string,
  cap: number,
): AutoContextSection {
  if (!fs.existsSync(dailyLogDir)) {
    return { label: 'DAILY', sourcePath: dailyLogDir, body: '', found: false };
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dailyLogDir);
  } catch (err) {
    if (!isExpectedReadError(err)) {
      throw err;
    }
    return { label: 'DAILY', sourcePath: dailyLogDir, body: '', found: false };
  }
  // Daily-log files are named `<YYYY-MM-DD>.md`. Sorting lexically
  // gives chronological order because the date format is fixed-width
  // and ISO-ordered. The latest entry is `.pop()`.
  // Match the YYYY-MM-DD.md shape and validate the date — `Date.parse`
  // rejects impossible calendar dates like 2026-04-32, which would
  // otherwise sort after a real entry and shadow it as "latest".
  const dailyFiles = entries
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .filter((f) => !Number.isNaN(Date.parse(f.slice(0, 10))))
    .sort();
  const latest = dailyFiles.pop();
  if (!latest) {
    return { label: 'DAILY', sourcePath: dailyLogDir, body: '', found: false };
  }
  const filePath = path.join(dailyLogDir, latest);
  return loadFileSection('DAILY', filePath, cap);
}

function truncate(body: string, cap: number): string {
  if (Buffer.byteLength(body, 'utf-8') <= cap) {
    return body;
  }
  // When the cap is too small to fit the truncation marker, the
  // result must still respect the cap — return a byte-truncated
  // prefix of the marker (or empty for cap <= 0). Without this,
  // a tiny cap returned the full marker and exceeded the byte
  // limit the caller relied on.
  const markerBytes = Buffer.byteLength(TRUNCATE_MARKER, 'utf-8');
  if (cap <= 0) {
    return '';
  }
  if (cap < markerBytes) {
    return byteTruncate(TRUNCATE_MARKER, cap);
  }
  const headroom = cap - markerBytes;
  // Slice by characters then re-check bytes: a tail of multi-byte
  // chars can push the body back over cap.
  let out = body.slice(0, headroom);
  while (Buffer.byteLength(out, 'utf-8') > headroom && out.length > 0) {
    out = out.slice(0, -1);
  }
  return out + TRUNCATE_MARKER;
}

/**
 * Truncate a string to at most `cap` bytes. Drops trailing chars
 * one at a time — naive, but the only callers operate on tiny
 * inputs (the truncation marker itself).
 */
function byteTruncate(s: string, cap: number): string {
  let out = s;
  while (Buffer.byteLength(out, 'utf-8') > cap && out.length > 0) {
    out = out.slice(0, -1);
  }
  return out;
}
