import fs from 'fs';

import {
  hostLogsDir,
  hostLogsOrchestratorFile,
  ORCHESTRATOR_LOG_MAX_BYTES,
  stripAnsi,
} from './host-logs.js';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

// Leading `(?<![A-Za-z0-9_])` anchors the match to a word boundary
// (start of string or a non-word character just before `bot`). Without
// the lookbehind the regex would chew into substrings — e.g.
// `robot1111111111:secret` has `bot1111111111:secret` inside it,
// which shouldn't be treated as a Telegram token. Real bot URLs and
// error messages always have `/bot` or start-of-string before the
// token, so the lookbehind loses no coverage.
const BOT_TOKEN_RE = /(?<![A-Za-z0-9_])bot(\d+):[A-Za-z0-9_-]+/g;

/**
 * Redact Telegram bot-token secrets from any log line before it lands
 * on disk / stderr.
 *
 * Grammy's `HttpError` / `FetchError` serializes the full request URL
 * into the error's `.message` and `.stack` properties — on every
 * Telegram send failure, the real bot token would otherwise land in
 * `logs/nanoclaw.log`. Logs often leave the host (debugging pastes,
 * shared diagnostics, log shipping); strip the secret before
 * write-time so the failure mode doesn't become a credential leak.
 *
 * The numeric bot ID before the colon stays, so operators can still
 * correlate main vs pool bots in log traces. Only the secret bytes
 * are replaced.
 *
 * Applied at the output layer so it covers every log path: direct
 * strings, formatted-data field values, and serialized Error
 * messages/stacks.
 *
 * @internal exported ONLY for `logger.test.ts` to exercise the regex
 *   directly. Application code must not call this — the logger
 *   already applies it to every write.
 */
export function redactBotTokens(input: string): string {
  return input.replace(BOT_TOKEN_RE, 'bot$1:<redacted>');
}

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{\n      "type": "${err.constructor.name}",\n      "message": "${err.message}",\n      "stack":\n          ${err.stack}\n    }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += `\n    ${KEY_COLOR}err${RESET}: ${formatErr(v)}`;
    } else {
      out += `\n    ${KEY_COLOR}${k}${RESET}: ${JSON.stringify(v)}`;
    }
  }
  return out;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// File sink state. The sink is `null` until the first write succeeds in
// initSink(); becomes `''` after a permanent failure so we don't keep
// retrying. Number of writes since the last size check is sampled
// every CHECK_EVERY writes — checking every write would `statSync` on
// every log line, multiplying syscall cost.
let sinkPath: string | null = null;
let writesSinceSizeCheck = 0;
let consecutiveWriteFailures = 0;
const SIZE_CHECK_EVERY = 256;
// After this many CONSECUTIVE write failures, mark the sink permanently
// disabled. Without a cap, a persistent EACCES (locked-down filesystem,
// chmod removed) would make every log line do init+append+retry — a
// hot loop that adds two failed syscalls per emitted log line. Three
// failures is enough to ride through a transient wipe (the test
// fixture pattern) without thrashing on a permanent break.
const MAX_CONSECUTIVE_WRITE_FAILURES = 3;

function initSink(): string | null {
  if (sinkPath !== null) return sinkPath || null;
  try {
    fs.mkdirSync(hostLogsDir(), { recursive: true });
    sinkPath = hostLogsOrchestratorFile();
    return sinkPath;
  } catch {
    // Transient mkdir failures shouldn't permanently disable the sink:
    // a startup race where DATA_DIR is mounted late, a brief
    // permission denial, or a parent directory that exists but isn't
    // writable yet would otherwise leave the orchestrator with no
    // file logging for its entire lifetime. Return null so the caller
    // skips THIS write, but leave sinkPath as null so the NEXT
    // writeToSink call retries the mkdir. The consecutive-failure
    // counter in writeToSink still trips the permanent-disable path
    // after several retries fail, so a truly unwritable filesystem
    // doesn't loop forever.
    return null;
  }
}

function writeToSink(line: string): void {
  const p = initSink();
  if (!p) {
    // Init returned null (transient mkdir failure or permanent-disable
    // sentinel). Bump the failure counter — without this, repeated
    // mkdir failures wouldn't ever trip the permanent-disable
    // threshold, making the retry loop into a hot path.
    consecutiveWriteFailures++;
    if (consecutiveWriteFailures >= MAX_CONSECUTIVE_WRITE_FAILURES) {
      sinkPath = ''; // permanent disable
    }
    return;
  }
  // Append in its own try/catch so a successful write isn't conflated
  // with a downstream rotation error. Without this split, an
  // appendFileSync that succeeds followed by a statSync that throws
  // (file got truncated by external tooling between append and stat,
  // brief filesystem hiccup) would be counted as a write failure and
  // reset sinkPath even though the line landed on disk.
  let appendOk = false;
  try {
    fs.appendFileSync(p, line);
    appendOk = true;
    consecutiveWriteFailures = 0;
  } catch {
    // Sink write must NEVER throw. The directory was probably
    // deleted out from under us (operator cleanup, log-rotation
    // tooling, test wipe between runs). Reset cached sinkPath,
    // re-init to recreate the dir, and retry the write ONCE so the
    // current line still lands on disk. After
    // MAX_CONSECUTIVE_WRITE_FAILURES failures in a row, mark the
    // sink permanently disabled — a persistent EACCES would
    // otherwise turn every subsequent log line into a
    // guaranteed-failed init+append pair.
    consecutiveWriteFailures++;
    if (consecutiveWriteFailures >= MAX_CONSECUTIVE_WRITE_FAILURES) {
      sinkPath = '';
      return;
    }
    sinkPath = null;
    const retryPath = initSink();
    if (!retryPath) return;
    try {
      fs.appendFileSync(retryPath, line);
      appendOk = true;
      consecutiveWriteFailures = 0;
    } catch {
      // Second failure on this call. Leave sinkPath as the
      // resurrected path so the next writeToSink retries init from
      // scratch, hitting the threshold check above on persistent
      // failure.
    }
  }
  if (!appendOk) return;

  // Periodic size check + rotation. Failures in this branch DO NOT
  // count against the write-failure budget — the line already landed
  // on disk; we just couldn't roll over. Worst case the log grows
  // past the cap until the next size check fires, which is benign.
  writesSinceSizeCheck++;
  if (writesSinceSizeCheck < SIZE_CHECK_EVERY) return;
  writesSinceSizeCheck = 0;
  try {
    const stat = fs.statSync(p);
    if (stat.size <= ORCHESTRATOR_LOG_MAX_BYTES) return;
    // Two-step rotation: unlink any prior `.1`, then rename. Both
    // halves wrapped in their own try/catch because `fs.renameSync`
    // does NOT overwrite an existing destination on Windows (NTFS
    // rejects the rename; only POSIX has overwrite semantics). The
    // unlink-first path works on every platform we deploy to. We
    // don't keep N rotations because the orchestrator log is
    // high-volume and `scripts/logrotate.sh` already handles richer
    // rotation when invoked externally — this internal rotation is
    // a safety net so a logrotate-less deployment can't fill disk.
    const rotated = `${p}.1`;
    try {
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
    } catch {
      // Old rotation locked / vanished. The renameSync below will
      // either succeed (POSIX overwrite) or fail (Windows / locked
      // file) — either way the outer catch handles it.
    }
    try {
      fs.renameSync(p, rotated);
    } catch {
      // Rename failed (cross-filesystem, dest still present on
      // Windows, EACCES). Leave the active file alone; try again
      // next size check.
    }
  } catch {
    // statSync threw. Skip this rotation cycle silently — the
    // append already succeeded, and we'll re-check next interval.
  }
}

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  // Build the full output line first, THEN redact. Doing the redaction
  // once on the final string is simpler than instrumenting every field
  // formatter — any path that can carry a token (msg text, structured
  // data value, stringified error, stack frame) goes through the same
  // filter on its way to the stream.
  const line =
    typeof dataOrMsg === 'string'
      ? `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${dataOrMsg}${RESET}\n`
      : `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${msg}${RESET}${formatData(dataOrMsg)}\n`;
  const redacted = redactBotTokens(line);
  stream.write(redacted);
  // The file sink gets the same content but ANSI-stripped — color codes
  // render as garbled `\x1b[...m` literals in tools that don't
  // interpret them (cat, most editors, the admin tile's file reads).
  writeToSink(stripAnsi(redacted));
}

export const logger = {
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('debug', dataOrMsg, msg),
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('info', dataOrMsg, msg),
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('warn', dataOrMsg, msg),
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('error', dataOrMsg, msg),
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('fatal', dataOrMsg, msg),
};

// Route uncaught errors through logger so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
