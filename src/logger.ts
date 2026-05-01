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
  stream.write(redactBotTokens(line));
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
