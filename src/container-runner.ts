/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  AGENT_AUTO_COMPACT_WINDOW,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  HOST_GID,
  HOST_PROJECT_ROOT,
  HOST_UID,
  IDLE_TIMEOUT,
  STORE_DIR,
  TILE_OWNER,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { onAgentLine } from './observer.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import { readEnvFile, readEnvFileAll } from './env.js';

/**
 * Select which tiles to install based on group trust tier.
 * Main: core + trusted + admin. Trusted: core + trusted. Untrusted: core + untrusted.
 * Admin loads last so it can override trusted skills.
 */
export interface TileRef {
  owner: string;
  name: string;
}

/**
 * Default owner for short-form tile names (kept for compat with historical
 * plain-string tile lists). Resolves via TILE_OWNER env / .env / fallback.
 */
function t(name: string): TileRef {
  return { owner: TILE_OWNER, name };
}

export function selectTiles(isMain: boolean, isTrusted: boolean): TileRef[] {
  if (isMain)
    return [
      t('nanoclaw-core'),
      t('nanoclaw-trusted'),
      t('nanoclaw-admin'),
      { owner: 'ligolnik', name: 'flight-weather-watch' },
    ];
  if (isTrusted)
    return [
      t('nanoclaw-core'),
      t('nanoclaw-trusted'),
      { owner: 'ligolnik', name: 'flight-weather-watch' },
    ];
  return [t('nanoclaw-core'), t('nanoclaw-untrusted')];
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/**
 * Container env vars whose VALUES are real secrets and must never appear
 * on the docker process command line — `ps -ef` and `/proc/<pid>/cmdline`
 * are world-readable on most kernels, so a `-e KEY=<real-secret>` flag
 * leaks the secret to any local user (and to monitoring tooling that
 * captures process tables). For these names we materialize an env-file
 * (mode 0600) and pass it via `--env-file <path>`; for everything else
 * (placeholders, non-secret config like AGENT_MODEL, NANOCLAW_CHAT_JID)
 * `-e KEY=value` is fine.
 *
 * Relationship with the `CONTAINER_VARS` list inside `buildContainerArgs`:
 * `CONTAINER_VARS` decides WHICH variables get forwarded at all (and is
 * gated by the trust tier — untrusted groups forward nothing).
 * `SECRET_CONTAINER_VARS` decides, OF THE FORWARDED ONES, which must
 * route through the env-file rather than `-e`. The two intentionally
 * serve different concerns; do not collapse one into the other.
 *
 * When introducing a new container env var that carries a real secret:
 * (1) add it to the local `CONTAINER_VARS` list so it's forwarded, AND
 * (2) add it here so the value goes through the env-file. Missing
 * either step leaves the secret either un-forwarded or back on the
 * command line.
 *
 * Variables with placeholder values (proxied through the credential
 * proxy) are NOT secrets and stay on the command line.
 */
export const SECRET_CONTAINER_VARS: ReadonlySet<string> = new Set([
  'COMPOSIO_API_KEY',
  'GITHUB_TOKEN',
]);

/**
 * Env vars from the host `.env` file that must NEVER be forwarded to
 * scheduled-task containers, even for trusted/main groups. These are either:
 *
 * (a) Channel bot tokens — forwarding would let container scripts bypass MCP
 *     and call the Telegram/Discord/Slack APIs directly, breaking audit trails.
 * (b) OAuth credentials that are managed by OneCLI or the credential proxy —
 *     they must flow through the proxy, not as raw env vars in the container.
 * (c) Orchestrator-internal vars already forwarded separately by
 *     `buildContainerArgs` (avoiding duplicates and accidental overrides).
 * (d) Host-only secrets that have no meaning inside a container.
 *
 * This list is intentionally conservative: when in doubt, keep a var out.
 * If a new channel or secret is added to `.env`, add it here too.
 * Third-party API keys (GOOGLE_MAPS_API_KEY, TOMTOM_API_KEY, etc.) that
 * script wrappers need are NOT in this list — they pass through (issue #18).
 */
export const BLOCKED_TASK_ENV_VARS: ReadonlySet<string> = new Set([
  // Anthropic / SDK (already forwarded as placeholder via credential proxy)
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Channel bot tokens
  'TELEGRAM_BOT_TOKEN',
  'WHATSAPP_SESSION_ID',
  'WHATSAPP_SESSION',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_SECRET',
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
  // OneCLI / credential proxy (already forwarded separately)
  'ONECLI_AGENT_TOKEN',
  'COMPOSIO_API_KEY',
  // GitHub PAT — already routed via SECRET_CONTAINER_VARS env-file (PR #32);
  // exclude here so a .env-defined value isn't double-forwarded.
  'GITHUB_TOKEN',
  // Nanoclaw orchestrator vars (forwarded separately or not needed in container)
  'AGENT_MODEL',
  'AGENT_EFFORT',
  'TIMEZONE',
  'TZ',
  'HOST_UID',
  'HOST_GID',
  'HOST_PROJECT_ROOT',
]);

/**
 * Result of materializing an env-file for a container spawn.
 * `args` are appended to the `docker run` argv; `cleanup` MUST be
 * invoked after the container exits (close OR error path) to remove
 * the on-disk file. The cleanup is idempotent — safe to call from
 * either handler regardless of whether the other already ran.
 */
export interface SecretEnvFile {
  args: string[];
  cleanup: () => void;
}

/**
 * Materialize a 0600-mode env-file containing the given secrets and
 * return docker `--env-file` args + a cleanup callback. Returns `null`
 * when there are no secrets to forward — the caller skips emitting
 * any extra args.
 *
 * Refuses to write a value containing CR/LF/NUL: docker's env-file
 * parser has no quoting, so an embedded newline would silently truncate
 * the variable or smuggle a second `KEY=...` line. Failing fast at
 * write time keeps the failure visible to the operator instead of
 * surfacing as a confusing "container can't find env var" later.
 *
 * Uses `O_CREAT | O_EXCL` with a random 24-hex-char suffix so a local
 * attacker can't pre-create the path as a symlink (symlink-race) and
 * exfiltrate the secret on write.
 */
export function buildSecretEnvFile(
  env: Record<string, string>,
): SecretEnvFile | null {
  const entries = Object.entries(env).filter(([, v]) => v !== '');
  if (entries.length === 0) return null;

  const lines = entries.map(([k, v]) => {
    if (/[\r\n\0]/.test(v)) {
      throw new Error(
        `Secret env var ${k} contains CR/LF/NUL; refusing to write env-file (docker env-file format has no quoting).`,
      );
    }
    return `${k}=${v}`;
  });

  const tmpPath = path.join(
    os.tmpdir(),
    `nanoclaw-env-${randomBytes(12).toString('hex')}`,
  );
  // O_EXCL fails if path exists; mode 0600 keeps the file unreadable
  // by other local users between open and the docker daemon's read.
  const fd = fs.openSync(
    tmpPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  // Write inside a nested try so a write failure (disk full, EIO,
  // EDQUOT) doesn't leave the file behind — the outer caller never
  // gets a cleanup callback if we throw, so we MUST unlink here
  // before rethrowing. Without this, a partial-secret tempfile
  // would persist on disk until the next reboot's tmpdir clear.
  try {
    try {
      fs.writeFileSync(fd, lines.join('\n') + '\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (unlinkErr) {
      if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(
          { err: unlinkErr, tmpPath },
          'Failed to clean up secret env-file after write error',
        );
      }
    }
    throw err;
  }

  let cleaned = false;
  return {
    args: ['--env-file', tmpPath],
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try {
        fs.unlinkSync(tmpPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        logger.warn(
          { err, tmpPath },
          'Failed to clean up secret env-file; will be cleared on next reboot via tmpdir',
        );
      }
    },
  };
}

/**
 * Model the agent-runner passes to the SDK's `query()` call. Forwarded as
 * the `AGENT_MODEL` env var on container spawn and read by
 * `container/agent-runner/src/index.ts`. Bumping this constant is the single
 * source of truth for the container agent's model — no rebuild of the
 * agent-runner image needed.
 *
 * Format: SDK model alias (`opus`, `sonnet[1m]`) or full model ID
 * (`claude-opus-4-7[1m]`). See
 * `container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
 * for the `model` field on `Options`.
 *
 * NOTE: changing the model family may require matching changes in
 * agent-runner's `query()` call. Opus 4.7 specifically needs
 * `thinking: { type: 'adaptive' }` (manual `type: 'enabled'` is rejected)
 * and does not support `effort: 'max'` well. The current runner is set up
 * for 4.7's expectations.
 */
// Light validation: trim whitespace (so `AGENT_MODEL="  "` falls back to
// the default rather than passing two spaces to the SDK) and warn on
// values that don't look like a Claude model ID. We don't enumerate a
// whitelist because the SDK accepts both aliases (`opus`, `sonnet[1m]`)
// and full IDs (`claude-opus-4-7[1m]`), the set churns with each model
// release, and a missed model would block legit upgrades. The warn
// surfaces typos at startup instead of at first `query()` call deep in
// runtime.
export const KNOWN_MODEL_PREFIX_RE = /^(claude|opus|sonnet|haiku)/i;
export function resolveAgentModel(raw: string | undefined): string {
  const fallback = 'claude-sonnet-4-6[1m]';
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (!KNOWN_MODEL_PREFIX_RE.test(trimmed)) {
    logger.warn(
      { agentModel: trimmed, fallback },
      'AGENT_MODEL does not look like a Claude model ID — will pass to SDK as-is, but check for a typo. Expected forms: full ID like "claude-opus-4-7[1m]" or alias like "opus" / "sonnet[1m]".',
    );
  }
  return trimmed;
}
const AGENT_MODEL = resolveAgentModel(process.env.AGENT_MODEL);

/**
 * Effort level the agent-runner passes to the SDK's `query()` call.
 * Forwarded as `AGENT_EFFORT` on container spawn.
 *
 * Resolution order (from highest precedence):
 *   1. `AGENT_EFFORT` environment variable on the orchestrator process
 *   2. The hardcoded default below (`xhigh`)
 *
 * Operators can override at runtime by setting `AGENT_EFFORT` in the
 * orchestrator's env (e.g. docker-compose, systemd unit), no rebuild
 * needed. The agent-runner validates the forwarded value against the
 * allowed set and falls back to `xhigh` on invalid input, so a typo
 * here won't crash containers — it'll log a warning inside the runner.
 *
 * Valid values: `'low' | 'medium' | 'high' | 'xhigh' | 'max'`.
 * - On Opus 4.7: `xhigh` is Anthropic's recommended default for
 *   coding/agentic work; `max` is reserved for frontier problems.
 * - On Opus 4.6 / Sonnet 4.6: `xhigh` silently falls back to `high` in
 *   the SDK.
 * See https://docs.anthropic.com/en/docs/build-with-claude/effort
 */
const AGENT_EFFORT = process.env.AGENT_EFFORT || 'xhigh';

/**
 * Create a filtered copy of messages.db containing only one group's messages.
 * Returns the path to the filtered DB, or null if the source DB doesn't exist.
 *
 * @internal Exported for tests only — untrusted-group DB isolation is
 *   security-critical and must be pinned by regression tests.
 */
export function createFilteredDb(
  chatJid: string,
  groupFolder: string,
): string | null {
  const srcDb = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(srcDb)) return null;

  const filteredDir = path.join(DATA_DIR, 'filtered-db', groupFolder);
  fs.mkdirSync(filteredDir, { recursive: true });
  const filteredPath = path.join(filteredDir, 'messages.db');

  // Remove stale copy from previous run
  if (fs.existsSync(filteredPath)) {
    fs.unlinkSync(filteredPath);
  }

  // Use ATTACH to copy schema-agnostically — picks up new columns automatically
  const dst = new Database(filteredPath);
  // busy_timeout must be set on every connection — it is a per-connection
  // setting, not a database-level property. Without it the ATTACH + CTAS
  // reads below would return SQLITE_BUSY immediately if the orchestrator is
  // mid-write, which can cause a transient "malformed image" failure.
  // journal_mode and synchronous are already WAL-persistent for the src DB;
  // we set them on dst too so the filtered copy is also WAL from birth.
  dst.pragma('journal_mode = WAL');
  dst.pragma('synchronous = NORMAL');
  dst.pragma('busy_timeout = 5000');
  try {
    dst.exec(`ATTACH DATABASE '${srcDb.replace(/'/g, "''")}' AS src`);
    dst.exec(
      `CREATE TABLE chats AS SELECT * FROM src.chats WHERE jid = '${chatJid.replace(/'/g, "''")}'`,
    );
    dst.exec(
      `CREATE TABLE messages AS SELECT * FROM src.messages WHERE chat_jid = '${chatJid.replace(/'/g, "''")}'`,
    );
    dst.exec('CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp)');
    // Reactions scoped to this chat only. check-unanswered.py joins on this
    // table to skip messages the bot already 👀-reacted to; without it, the
    // join hits "no such table: reactions" and the whole script aborts.
    // Created unconditionally so untrusted containers don't depend on
    // whether the host happens to have any reactions yet — even an empty
    // table satisfies the join. CTAS can't run if src.reactions doesn't
    // exist (fresh install before migrations), so fall back to an empty
    // table with the known schema in that case.
    try {
      dst.exec(`
        CREATE TABLE reactions AS
          SELECT r.* FROM src.reactions r
          WHERE r.message_chat_jid = '${chatJid.replace(/'/g, "''")}'
      `);
    } catch {
      dst.exec(`
        CREATE TABLE reactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL,
          message_chat_jid TEXT NOT NULL,
          reactor_jid TEXT NOT NULL,
          reactor_name TEXT NOT NULL,
          emoji TEXT NOT NULL,
          timestamp TEXT NOT NULL
        )
      `);
    }
    dst.exec(
      'CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, message_chat_jid)',
    );
    dst.exec('DETACH src');
  } finally {
    dst.close();
  }

  // Chown so container user can read
  const uid = HOST_UID ?? 1000;
  const gid = HOST_GID ?? 1000;
  if (uid !== 0) {
    try {
      fs.chownSync(filteredDir, uid, gid);
      fs.chownSync(filteredPath, uid, gid);
    } catch (err: unknown) {
      logger.warn({ err, filteredPath }, 'Failed to chown filtered DB');
    }
  }

  logger.debug(
    { chatJid, groupFolder, path: filteredPath },
    'Created filtered DB for untrusted container',
  );

  return filteredPath;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isTrusted?: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  replyToMessageId?: string;
  /**
   * Which per-group session this container run belongs to. Drives the
   * `.claude/` dir location and the group-queue slot key.
   * - `'default'` (omitted): user-facing Andy, serves inbound IPC messages.
   * - `'maintenance'`: scheduled Andy, runs scheduled_tasks (heartbeat,
   *   nightly, weekly, reminders). Runs in parallel with `'default'` for the
   *   same group so maintenance never blocks user replies.
   *
   * Invariant: inbound Telegram/etc. messages ALWAYS route to `'default'`.
   * `src/task-scheduler.ts` is the sole writer of `'maintenance'`.
   */
  sessionName?: string;
  /**
   * Continuation marker for self-resuming cycles. Set only on
   * scheduled-task spawns whose `scheduled_tasks.continuation_cycle_id`
   * column is non-NULL. When present the spawned container gets:
   *   - `NANOCLAW_CONTINUATION=1`
   *   - `NANOCLAW_CONTINUATION_CYCLE_ID=<value>`
   *
   * Absence (undefined / empty) means "fresh invocation" — neither env
   * var is set, and that absence is itself the signal the calling skill
   * cross-checks against its prompt-prefix marker. Mismatch fails
   * closed to fresh invocation; a scheduler that sets the env but
   * mangles the prompt (or vice versa) therefore never silently
   * bypasses whatever continuation/lock contract the chain depends on.
   */
  continuationCycleId?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamText?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Recursively chown a host-side directory, NEVER following symlinks.
 *
 * Security: earlier implementation used `fs.chownSync` which follows
 * symlinks. If a container could create a symlink inside one of its
 * writable mounts (e.g. `shared-memory/evil` → `/etc/passwd`), the next
 * spawn's chown would change ownership of the target — a privilege
 * escalation path out of the container into the host. `lchownSync`
 * operates on the link itself; `withFileTypes: true` + `entry.isDirectory()`
 * only recurses into real directories, so symlinks are chowned but not
 * traversed.
 */
function chownRecursive(dir: string, uid: number, gid: number): void {
  fs.lchownSync(dir, uid, gid);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    fs.lchownSync(fullPath, uid, gid);
    // `isDirectory()` returns false for symlinks (even symlinks to dirs)
    // because we used `withFileTypes: true`, which reads the dirent type
    // without resolving the link. Recursion is therefore symlink-safe.
    if (entry.isDirectory()) {
      chownRecursive(fullPath, uid, gid);
    }
  }
}

/**
 * Translate a local container path to a host path for docker -v arguments.
 * In Docker-out-of-Docker, the orchestrator's filesystem (/app/...) differs
 * from the host's (HOST_PROJECT_ROOT/...). Mount paths must use host paths.
 */
function toHostPath(localPath: string): string {
  const projectRoot = process.cwd();
  if (HOST_PROJECT_ROOT === projectRoot) return localPath; // running directly on host
  const rel = path.relative(projectRoot, localPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return localPath; // outside project
  return path.join(HOST_PROJECT_ROOT, rel);
}

/**
 * Files in the project root that contain secrets (bot tokens, API keys).
 * Main-group containers get `/dev/null` mounted over each of these so agents
 * can't read tokens and bypass the credential proxy.
 *
 * Security-critical: adding a new secret file ANYWHERE in the repo requires
 * adding it to this list, or an agent in the main group can read it.
 */
export const SECRET_FILES = [
  '.env',
  '.env.bak',
  'data/env/env',
  'scripts/heartbeat-external.conf',
] as const;

/**
 * Default `sessionName` when callers don't pass one. User-facing paths
 * (inbound IPC messages) resolve here. Scheduled tasks pass `'maintenance'`
 * to get a parallel container slot. See `ContainerInput.sessionName` docs.
 */
export const DEFAULT_SESSION_NAME = 'default';

/**
 * Per-session subdir name under `<DATA_DIR>/ipc/<folder>/` for the input
 * side of the IPC channel. Each session gets its own subdir so `_close`
 * sentinels and follow-up JSON messages written for one session never
 * leak into the other session's container.
 *
 * Exported so group-queue writes to the same path the container-runner
 * mounted — both must agree on the location. Kept in sync at compile time.
 *
 * Session name is validated here so every caller (orchestrator-trusted
 * and IPC-untrusted alike) gets the same guard. A malicious container
 * that manages to stamp `sessionName: "../default"` onto its IPC request
 * would, without this check, redirect `scriptResultPath` or mount
 * construction into a directory outside the expected `ipc/<group>/`
 * subtree. The allowlist pattern is deliberately narrow — `default`,
 * `maintenance`, and any hypothetical future slot all fit within
 * `[A-Za-z0-9_-]+`.
 */
const VALID_SESSION_NAME_RE = /^[A-Za-z0-9_-]+$/;
export function sessionInputDirName(sessionName: string): string {
  if (!VALID_SESSION_NAME_RE.test(sessionName)) {
    throw new Error(
      `Invalid session name: ${JSON.stringify(sessionName)} — must match ${VALID_SESSION_NAME_RE}`,
    );
  }
  return `input-${sessionName}`;
}

/**
 * Claude Code's SDK slugifies each project's working directory path into a
 * subdirectory name under `~/.claude/projects/`. For our container the
 * project root is `/workspace/group`, so the slug is `-workspace-group`
 * (slashes replaced with leading dashes). The SDK writes transcripts,
 * feedback, and memory under this path.
 *
 * We bind-mount a shared `memory/` subdir inside it (see `buildVolumeMounts`)
 * so auto-memory is owner-level state, not per-session — otherwise feedback
 * written to one session's `.claude/` is invisible to the other.
 *
 * If Claude Code ever changes its slug convention, update this const.
 * Graceful degradation if it does drift: the mount target mismatches the
 * SDK's path and auto-memory falls back to per-session (pre-PR-#57
 * behaviour) — annoying, not broken.
 */
const CLAUDE_PROJECT_SLUG = '-workspace-group';

/**
 * @internal Exported for tests only — mount-list construction is
 *   security-critical (trust tiers, secret shadowing, untrusted read-only).
 */
export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  chatJid: string,
  sessionName: string = DEFAULT_SESSION_NAME,
): VolumeMount[] {
  // Validate `sessionName` at the earliest point it's used as a filesystem
  // path segment. The same allowlist `sessionInputDirName` enforces — kept
  // in sync so no mount can be built with a name that would later be
  // rejected at IPC time, and no caller can smuggle `..` into the sessions
  // dir path (which happens BEFORE `sessionInputDirName` is reached).
  if (!VALID_SESSION_NAME_RE.test(sessionName)) {
    throw new Error(
      `Invalid session name: ${JSON.stringify(sessionName)} — must match ${VALID_SESSION_NAME_RE}`,
    );
  }
  const mounts: VolumeMount[] = [];
  const groupDir = resolveGroupFolderPath(group.folder);

  // Ensure AGENTS.md exists (chains .tessl/RULES.md into Claude Code context).
  // Must be created BEFORE the mount goes read-only for untrusted groups.
  const agentsMdPath = path.join(groupDir, 'AGENTS.md');
  if (!fs.existsSync(agentsMdPath)) {
    fs.writeFileSync(
      agentsMdPath,
      '\n\n# Agent Rules <!-- managed by orchestrator -->\n\n@.tessl/RULES.md follow the [instructions](.tessl/RULES.md)\n',
    );
  }

  if (isMain) {
    // Main gets the project root read-only.
    mounts.push({
      hostPath: toHostPath(process.cwd()),
      containerPath: '/workspace/project',
      readonly: true,
    });
    // Shadow ALL files containing secrets so agents can't read bot tokens.
    // Without this, subagents curl the Telegram API directly, bypassing MCP.
    // mount --bind inside the container doesn't work (needs CAP_SYS_ADMIN),
    // so we mount /dev/null over every secret file from the orchestrator.
    for (const relPath of SECRET_FILES) {
      const absPath = path.join(process.cwd(), relPath);
      if (fs.existsSync(absPath)) {
        mounts.push({
          hostPath: '/dev/null',
          containerPath: `/workspace/project/${relPath}`,
          readonly: true,
        });
      }
    }
  }

  // Group folder mount. Untrusted groups get read-only (disk exhaustion protection).
  mounts.push({
    hostPath: toHostPath(groupDir),
    containerPath: '/workspace/group',
    readonly: !isMain && !group.containerConfig?.trusted,
  });

  // Global memory directory (SOUL.md, shared CLAUDE.md).
  // Trusted + main get the full directory. Untrusted get only SOUL-untrusted.md
  // mounted as SOUL.md so core-behavior's "read SOUL.md" still works.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (isMain || group.containerConfig?.trusted) {
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: toHostPath(globalDir),
        containerPath: '/workspace/global',
        readonly: !isMain,
      });
    }
  } else {
    // Untrusted: mount only the sanitized SOUL as a single file
    const untrustedSoul = path.join(globalDir, 'SOUL-untrusted.md');
    if (fs.existsSync(untrustedSoul)) {
      mounts.push({
        hostPath: toHostPath(untrustedSoul),
        containerPath: '/workspace/global/SOUL.md',
        readonly: true,
      });
    }
  }

  // .env shadowing is handled inside the container entrypoint via mount --bind
  // (Apple Container only supports directory mounts, not file mounts like /dev/null)

  // Shared trusted directory — writable space for trusted containers.
  if (isMain || group.containerConfig?.trusted) {
    const trustedDir = path.join(process.cwd(), 'trusted');
    fs.mkdirSync(trustedDir, { recursive: true });
    // Chown so container user can write memory files
    const trustedUid = HOST_UID ?? 1000;
    const trustedGid = HOST_GID ?? 1000;
    if (trustedUid !== 0) {
      try {
        fs.chownSync(trustedDir, trustedUid, trustedGid);
      } catch (err: unknown) {
        logger.warn({ err, trustedDir }, 'Failed to chown trusted dir');
      }
    }
    mounts.push({
      hostPath: toHostPath(trustedDir),
      containerPath: '/workspace/trusted',
      readonly: false,
    });
  }

  // Store directory (messages.db).
  // Trusted/main: full DB (all groups). Untrusted: filtered copy (own chat only).
  if (isMain || group.containerConfig?.trusted) {
    const storeDir = path.join(process.cwd(), 'store');
    if (fs.existsSync(storeDir)) {
      mounts.push({
        hostPath: toHostPath(storeDir),
        containerPath: '/workspace/store',
        readonly: true,
      });
    }
  } else {
    // Untrusted: create filtered DB with only this group's messages
    const filteredDb = createFilteredDb(chatJid, group.folder);
    if (filteredDb) {
      mounts.push({
        hostPath: toHostPath(path.dirname(filteredDb)),
        containerPath: '/workspace/store',
        readonly: true,
      });
    }
  }

  // Per-group-per-session Claude sessions directory. The extra `sessionName`
  // segment isolates the user-facing (`default`) and scheduled (`maintenance`)
  // Andys so their SDK transcripts, `settings.json`, skills/ and .tessl/
  // trees never collide when both run concurrently for the same group.
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    sessionName,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  // Write settings.json only if content has changed — unnecessary rewrites
  // invalidate the SDK's prompt cache (file mtime changes trigger cache misses).
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const newSettings =
    JSON.stringify(
      {
        env: {
          // NOTE: model selection is NOT controlled here. The agent-runner
          // calls the SDK's query() directly (not via the Claude Code CLI),
          // and the SDK takes `model` as a query() parameter. We pass it as
          // `AGENT_MODEL` on the container env (see below) so the runner can
          // read it at call time. `CLAUDE_CODE_MODEL` is not a real Claude
          // Code env var — previously set here but silently ignored.
          CLAUDE_CODE_MAX_CONTEXT_WINDOW: '1000000',
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          CLAUDE_CODE_EFFORT_LEVEL: 'max',
          // Disable auto-memory for untrusted groups to prevent persistent injection
          CLAUDE_CODE_DISABLE_AUTO_MEMORY:
            isMain || group.containerConfig?.trusted ? '0' : '1',
        },
      },
      null,
      2,
    ) + '\n';
  if (
    !fs.existsSync(settingsFile) ||
    fs.readFileSync(settingsFile, 'utf-8') !== newSettings
  ) {
    fs.writeFileSync(settingsFile, newSettings);
  }

  // Tile delivery — all host-side, no tessl CLI in containers.
  // Build .tessl structure and skills/ from registry-installed tiles (tessl-workspace).
  // Main/trusted get all tiles. Others get nanoclaw-core only.
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsDst)) {
    fs.rmSync(skillsDst, { recursive: true, force: true });
  }
  fs.mkdirSync(skillsDst, { recursive: true });

  const dstTessl = path.join(groupSessionsDir, '.tessl');
  if (fs.existsSync(dstTessl)) {
    fs.rmSync(dstTessl, { recursive: true, force: true });
  }

  const tilesToInstall = selectTiles(isMain, !!group.containerConfig?.trusted);

  // Tiles live under `tessl-workspace/.tessl/tiles/<owner>/<name>/`. Each
  // tile brings its own owner now (tiles can come from different publishers),
  // so we resolve per-tile rather than using one TILE_OWNER-rooted dir.
  const registryRoot = path.join(
    process.cwd(),
    'tessl-workspace',
    '.tessl',
    'tiles',
  );
  const tilePath = (t: TileRef) => path.join(registryRoot, t.owner, t.name);

  // Build the group's tile-managed scripts/ in a sibling tmp dir, then
  // publish it atomically via a symlink flip (see the swap block below).
  // Writing directly into `groups/<folder>/scripts/` would create two
  // separate problems the moment two sessions run concurrently:
  //   1. Stale scripts from removed-in-new-tile skills lingered (the bug
  //      that drove the "DB size crossed N MB" rogue-heartbeat behaviour).
  //   2. A naive `rmSync(groupScriptsDir)` before the copy loop opens a
  //      race window where the other session reads a half-populated dir.
  // Tmp-then-publish gives both sessions a valid snapshot at all times:
  // whichever session finishes last wins the publish, and both end states
  // are equivalent (same installed tile version).
  const groupScriptsDir = path.join(groupDir, 'scripts');
  const rulesContent: string[] = [];
  // Registry-availability guard: if not a single tile in `tilesToInstall`
  // actually exists under `registryTiles`, skip the whole build-and-swap.
  // Otherwise the tmpdir + atomic flip would publish an EMPTY scripts/
  // symlink, wiping the previous version — which is worse than stale.
  // Root causes this defends against: tessl install failed on this spawn,
  // the registry mount glitched, a first-boot race. The per-tile
  // `fs.existsSync(tileSrc)` check inside the loop still handles partial
  // degradation (some tiles present, others missing).
  const anyTileAvailable = tilesToInstall.some((t) =>
    fs.existsSync(tilePath(t)),
  );
  if (!anyTileAvailable) {
    logger.warn(
      { registryRoot, tilesToInstall, groupScriptsDir },
      'No tile sources available — keeping existing groupScriptsDir and .tessl/RULES.md intact. Investigate tessl install state.',
    );
  } else {
    const scriptsTmpSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const tmpScriptsDir = `${groupScriptsDir}.new.${scriptsTmpSuffix}`;
    fs.mkdirSync(tmpScriptsDir, { recursive: true });

    for (const tileRef of tilesToInstall) {
      const tileName = tileRef.name;
      const tileSrc = tilePath(tileRef);
      if (!fs.existsSync(tileSrc)) {
        logger.warn(
          { tile: `${tileRef.owner}/${tileRef.name}`, path: tileSrc },
          'Tile not found — run tessl install in orchestrator',
        );
        continue;
      }

      const dstTileDir = path.join(dstTessl, 'tiles', tileRef.owner, tileName);

      // Copy rules
      const rulesDir = path.join(tileSrc, 'rules');
      if (fs.existsSync(rulesDir)) {
        for (const ruleFile of fs.readdirSync(rulesDir)) {
          if (!ruleFile.endsWith('.md')) continue;
          const ruleSrcFile = path.join(rulesDir, ruleFile);
          const ruleDst = path.join(dstTileDir, 'rules', ruleFile);
          fs.mkdirSync(path.dirname(ruleDst), { recursive: true });
          fs.cpSync(ruleSrcFile, ruleDst);
          rulesContent.push(fs.readFileSync(ruleSrcFile, 'utf8'));
        }
      }

      // Copy skills and their scripts
      const tileSkillsDir = path.join(tileSrc, 'skills');
      if (fs.existsSync(tileSkillsDir)) {
        for (const skillDir of fs.readdirSync(tileSkillsDir)) {
          const skillSrcDir = path.join(tileSkillsDir, skillDir);
          if (!fs.statSync(skillSrcDir).isDirectory()) continue;
          fs.cpSync(skillSrcDir, path.join(dstTileDir, 'skills', skillDir), {
            recursive: true,
          });
          fs.cpSync(skillSrcDir, path.join(skillsDst, `tessl__${skillDir}`), {
            recursive: true,
          });
          // Copy bundled scripts into the tmp scripts dir; swap happens below,
          // after all tiles' skills are processed. Scripts at this path are
          // used by named host operations and referenced from skills as
          // `/workspace/group/scripts/<name>`.
          const skillScriptsDir = path.join(skillSrcDir, 'scripts');
          if (fs.existsSync(skillScriptsDir)) {
            for (const scriptFile of fs.readdirSync(skillScriptsDir)) {
              fs.cpSync(
                path.join(skillScriptsDir, scriptFile),
                path.join(tmpScriptsDir, scriptFile),
              );
            }
          }
        }
      }
    }

    // Atomic symlink-based publish for `groups/<folder>/scripts/`. Readers
    // must ALWAYS find `groupScriptsDir` present — the previous "rename old
    // aside, rename new into place" design had a brief ENOENT window between
    // the two renames where a concurrent agent running `/workspace/group/
    // scripts/<file>` would fail (CodeQL correctness finding).
    //
    // New layout:
    //   groups/<folder>/scripts             ──► symlink
    //   groups/<folder>/scripts.version.<id> ──► real directory (one per publish)
    //
    // Publish steps:
    //   1. rename `tmpScriptsDir` → `scripts.version.<id>` (a unique sibling)
    //   2. create a temporary symlink `scripts.link.<id>` → that version
    //   3. atomically rename the symlink over `groupScriptsDir` (POSIX rename
    //      on a symlink replaces an existing symlink atomically)
    //   4. delete the previous version dir (if any)
    //
    // First-install path: no `groupScriptsDir` exists; we just rename the
    // temp symlink into place — still atomic, no window.
    //
    // Legacy path: pre-this-commit installs have a REAL directory at
    // `groupScriptsDir` (not a symlink). We can't atomically replace a
    // non-empty directory with a symlink. For that one-time transition we
    // do `rm -rf <dir>` + `symlink` — has a brief window, but runs exactly
    // once per group, ever, and is bounded.
    const RACE_CODES = new Set(['EEXIST', 'ENOTEMPTY']);
    const swapId = `${Date.now()}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    const newVersionDir = `${groupScriptsDir}.version.${swapId}`;
    const tmpLink = `${groupScriptsDir}.link.${swapId}`;
    let previousVersionDir: string | null = null;

    const rmBestEffort = (target: string): void => {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        /* ignore — orphaned artefacts don't affect correctness */
      }
    };

    try {
      // 1. Publish our tmp build as a versioned sibling.
      fs.renameSync(tmpScriptsDir, newVersionDir);

      // 2. Inspect what's currently at `groupScriptsDir` (symlink, real dir,
      //    or missing).
      let liveStat: fs.Stats | null = null;
      try {
        liveStat = fs.lstatSync(groupScriptsDir);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw err;
      }
      if (liveStat && liveStat.isSymbolicLink()) {
        // Remember the previous version so we can clean it up after the flip.
        try {
          const currentTarget = fs.readlinkSync(groupScriptsDir);
          previousVersionDir = path.isAbsolute(currentTarget)
            ? currentTarget
            : path.resolve(path.dirname(groupScriptsDir), currentTarget);
        } catch {
          /* ignore — if we can't read the link we just won't clean it up */
        }
      }

      // 3. Create the temp symlink. Relative target so moves of the parent
      //    dir don't break the link. `'dir'` hint matters only on Windows.
      fs.symlinkSync(path.basename(newVersionDir), tmpLink, 'dir');

      if (liveStat && !liveStat.isSymbolicLink()) {
        // Legacy layout: real dir at `groupScriptsDir`. Can't atomically
        // replace a non-empty directory with a symlink; remove it first.
        // This is the one-time per-group transition; steady state uses
        // the pure atomic rename below.
        fs.rmSync(groupScriptsDir, { recursive: true, force: true });
      }

      // 4. Atomic flip: POSIX rename on a symlink replaces an existing
      //    symlink atomically. On the first-install path (no prior
      //    symlink) this just creates the symlink. Either way
      //    `groupScriptsDir` resolves to a valid versioned dir from
      //    here on.
      fs.renameSync(tmpLink, groupScriptsDir);

      // 5. Clean up the previous versioned dir (if any).
      if (previousVersionDir) rmBestEffort(previousVersionDir);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      const isRace = code ? RACE_CODES.has(code) : false;

      // Always drop our publish artefacts: if the race winner placed a
      // correct `groupScriptsDir` our versioned dir is redundant; on a
      // real error we can't trust our partial build.
      rmBestEffort(tmpLink);
      rmBestEffort(newVersionDir);
      rmBestEffort(tmpScriptsDir);

      if (isRace) {
        logger.debug(
          { err, groupScriptsDir },
          'scripts/ publish raced with concurrent setup; keeping winning copy',
        );
      } else {
        logger.error(
          { err, code, groupScriptsDir },
          'scripts/ publish failed unexpectedly (not a race)',
        );
        // Rethrow non-race errors so the spawn fails loudly. Unlike the
        // previous design, `groupScriptsDir` (if it existed) is still
        // present — either still a symlink pointing at the previous
        // version, or still the legacy real dir — so even a failed
        // publish doesn't leave the group with missing scripts.
        throw err;
      }
    }
  } // end registry-availability guard

  // Write aggregated RULES.md
  if (rulesContent.length > 0) {
    fs.mkdirSync(dstTessl, { recursive: true });
    fs.writeFileSync(
      path.join(dstTessl, 'RULES.md'),
      rulesContent.join('\n\n---\n\n'),
    );
  }

  // Copy .tessl/ to group folder so AGENTS.md → .tessl/RULES.md resolves.
  // Host-side copy is required because untrusted groups mount /workspace/group
  // read-only — the container cannot write .tessl/ there itself.
  // Skip if RULES.md content is unchanged (avoids unnecessary I/O on every spawn).
  const groupTesslDir = path.join(groupDir, '.tessl');
  if (fs.existsSync(dstTessl)) {
    const srcRules = path.join(dstTessl, 'RULES.md');
    const dstRules = path.join(groupTesslDir, 'RULES.md');
    const needsCopy =
      fs.existsSync(srcRules) &&
      (!fs.existsSync(dstRules) ||
        fs.readFileSync(srcRules, 'utf-8') !==
          fs.readFileSync(dstRules, 'utf-8'));
    if (needsCopy) {
      if (fs.existsSync(groupTesslDir)) {
        fs.rmSync(groupTesslDir, { recursive: true, force: true });
      }
      fs.cpSync(dstTessl, groupTesslDir, { recursive: true });
    }
  }

  // Built-in container skills (agent-browser, status, etc.)
  const builtinSkillsDir = path.join(process.cwd(), 'container', 'skills');
  // Skills only for trusted containers (main or trusted=true in containerConfig).
  const trustedOnlySkills = new Set(['google-calendar']);
  const isTrustedContainer = isMain || group.containerConfig?.trusted === true;
  if (fs.existsSync(builtinSkillsDir)) {
    for (const skillDir of fs.readdirSync(builtinSkillsDir)) {
      if (!isTrustedContainer && trustedOnlySkills.has(skillDir)) continue;
      const srcDir = path.join(builtinSkillsDir, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      fs.cpSync(srcDir, path.join(skillsDst, skillDir), { recursive: true });
    }
  }

  // Andy-created skills (staging) — override tile skills if names collide
  const groupSkillsDir = path.join(groupDir, 'skills');
  if (fs.existsSync(groupSkillsDir)) {
    const stagingSkills = fs.readdirSync(groupSkillsDir).filter((d) => {
      const p = path.join(groupSkillsDir, d);
      return fs.statSync(p).isDirectory();
    });
    if (stagingSkills.length > 0) {
      logger.warn(
        { folder: group.folder, skills: stagingSkills },
        'Staging skills override tile skills — run verify-tiles to clear',
      );
      for (const skillDir of stagingSkills) {
        fs.cpSync(
          path.join(groupSkillsDir, skillDir),
          path.join(skillsDst, skillDir),
          { recursive: true },
        );
      }
    }
  }
  // Chown the .claude session dir so the container user (node) can write to it.
  // The SDK creates subdirs like session-env/ at runtime — without this, EACCES.
  const sessionUid = HOST_UID ?? 1000;
  const sessionGid = HOST_GID ?? 1000;
  if (sessionUid !== 0) {
    try {
      chownRecursive(groupSessionsDir, sessionUid, sessionGid);
    } catch (err: unknown) {
      logger.warn(
        { err, groupSessionsDir },
        'Failed to chown .claude session dir',
      );
    }
  }
  mounts.push({
    hostPath: toHostPath(groupSessionsDir),
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Shared auto-memory mount (issue #57). Claude Code's SDK writes
  // accumulated feedback and owner-profile memory to
  // ~/.claude/projects/<slug>/memory/. PR #55 mounted `.claude/` per-session,
  // which also split memory between `default` and `maintenance` — feedback
  // from one was invisible to the other. Memory describes the owner, not a
  // session, so it belongs shared.
  //
  // Overlay pattern: the per-session `.claude/` mount above gives each
  // container its own `projects/<slug>/*.jsonl` transcripts. This second
  // bind mount overlays only the `memory/` subdirectory with the shared
  // dir. Docker applies nested bind mounts in order; the later mount
  // replaces the contents at its path. Result: transcripts stay
  // per-session, memory is shared.
  //
  // Trust-tier gate: settings.json above sets
  // `CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'` on untrusted containers to
  // block persistent prompt injection. We must NOT give those containers
  // a shared writable owner-state dir — an untrusted container that
  // bypassed the env var (direct fs write, SDK bug, etc.) would poison
  // the owner-memory that main/trusted containers read. Gate the mount,
  // mkdir, migration, and chown behind the same trust condition.
  const autoMemoryEnabled = isMain || !!group.containerConfig?.trusted;
  if (autoMemoryEnabled) {
    const sharedMemoryDir = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      'shared-memory',
    );
    fs.mkdirSync(sharedMemoryDir, { recursive: true });

    // Pre-create the overlay mount target inside the `.claude` bind. Docker
    // applies the shared-memory mount at
    // `/home/node/.claude/projects/<slug>/memory` on top of the outer `.claude`
    // mount, which requires the mountpoint path to exist on the lower
    // filesystem. Without this pre-creation Docker auto-mkdirs the missing
    // ancestors as uid 0, leaving `projects/` and `projects/<slug>/` root-owned
    // on the host — which breaks node-user writes to per-session transcripts
    // that the SDK writes alongside `memory/` (e.g. `projects/<slug>/*.jsonl`).
    // The outer `chownRecursive(groupSessionsDir, ...)` above already ran, so
    // we chown the new subtree explicitly here.
    const projectsDir = path.join(groupSessionsDir, 'projects');
    const memoryMountTarget = path.join(
      projectsDir,
      CLAUDE_PROJECT_SLUG,
      'memory',
    );
    fs.mkdirSync(memoryMountTarget, { recursive: true });
    if (sessionUid !== 0) {
      try {
        chownRecursive(projectsDir, sessionUid, sessionGid);
      } catch (err: unknown) {
        logger.warn(
          { err, projectsDir },
          'Failed to chown projects/ overlay mount-target tree',
        );
      }
    }

    // One-shot migration: for installations upgrading from PR #55 (per-session
    // memory) to #57 (shared memory), scan each per-session `memory/` dir for
    // files that haven't made it into shared-memory yet and copy them over.
    // Shared-memory wins on conflict (it's the newer source of truth); the
    // per-session copy is left in place but orphaned — subsequent reads go
    // through the shared mount. Safe to run every spawn: only acts on files
    // that exist per-session but NOT in shared.
    // Hardcoded rather than importing MAINTENANCE_SESSION_NAME from
    // group-queue (that would add a circular dep — group-queue already
    // imports from here). These are the two session names that existed
    // before this migration lands, so the list is fixed by history.
    for (const otherSession of ['default', 'maintenance']) {
      const perSessionMemoryDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        otherSession,
        '.claude',
        'projects',
        CLAUDE_PROJECT_SLUG,
        'memory',
      );
      if (!fs.existsSync(perSessionMemoryDir)) continue;
      let entries: string[];
      try {
        entries = fs.readdirSync(perSessionMemoryDir);
      } catch {
        continue;
      }
      for (const file of entries) {
        const src = path.join(perSessionMemoryDir, file);
        const dst = path.join(sharedMemoryDir, file);
        if (fs.existsSync(dst)) continue;
        try {
          fs.cpSync(src, dst, { recursive: true, force: false });
          logger.info(
            { group: group.folder, file, fromSession: otherSession },
            'Migrated per-session memory file to shared-memory',
          );
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          // EEXIST / ERR_FS_CP_EEXIST: another session spawning concurrently
          // won the cpSync — our copy is redundant, their content is valid
          // (same source file, same target). Expected race in steady state;
          // log at debug so parallel startup doesn't spam warn logs.
          if (code === 'EEXIST' || code === 'ERR_FS_CP_EEXIST') {
            logger.debug(
              { src, dst },
              'Concurrent session won the shared-memory migration — keeping winner',
            );
          } else {
            logger.warn(
              { err, src, dst },
              'Failed to migrate per-session memory file',
            );
          }
        }
      }
    }

    if (sessionUid !== 0) {
      try {
        chownRecursive(sharedMemoryDir, sessionUid, sessionGid);
      } catch (err: unknown) {
        logger.warn(
          { err, sharedMemoryDir },
          'Failed to chown shared-memory dir',
        );
      }
    }
    mounts.push({
      hostPath: toHostPath(sharedMemoryDir),
      containerPath: `/home/node/.claude/projects/${CLAUDE_PROJECT_SLUG}/memory`,
      readonly: false,
    });
  } // end autoMemoryEnabled

  // Claude Code config file — lives at /home/node/.claude.json (outside .claude/).
  // Read-only rootfs can't create it, so we bind-mount it from the sessions dir.
  // Kept alongside the per-session `.claude/` dir so default and maintenance
  // Andys don't share Claude Code's per-session config.
  const claudeJsonPath = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    sessionName,
    '.claude.json',
  );
  if (!fs.existsSync(claudeJsonPath)) {
    fs.writeFileSync(claudeJsonPath, '{}');
  }
  // Chown so container user can write (Claude Code updates this file at runtime)
  const jsonUid = HOST_UID ?? 1000;
  const jsonGid = HOST_GID ?? 1000;
  if (jsonUid !== 0) {
    try {
      fs.chownSync(claudeJsonPath, jsonUid, jsonGid);
    } catch (err: unknown) {
      logger.warn({ err, claudeJsonPath }, 'Failed to chown .claude.json');
    }
  }
  mounts.push({
    hostPath: toHostPath(claudeJsonPath),
    containerPath: '/home/node/.claude.json',
    readonly: false,
  });

  // Per-group IPC namespace. `input/` is per-session so parallel default
  // and maintenance containers don't step on each other's _close sentinel
  // or follow-up JSON files. `messages/` and `tasks/` stay shared — they're
  // outbound from the container and the host aggregates both sessions' output.
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const sessionInputSubdir = sessionInputDirName(sessionName);
  const sessionInputDir = path.join(groupIpcDir, sessionInputSubdir);
  const isTrustedIpc = isMain || !!group.containerConfig?.trusted;
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(sessionInputDir, { recursive: true });

  // Wipe stale sentinel files from previous container lifecycles. A `_close`
  // left over from a graceful shutdown will be consumed by a fresh
  // container's first IPC poll and end its input stream prematurely — the
  // SDK still finishes the in-flight prompt, but the container exits
  // immediately after, so the next user message takes the cost of a fresh
  // spawn. Clean here, where we know we're about to start a new container.
  const staleClose = path.join(sessionInputDir, '_close');
  if (fs.existsSync(staleClose)) {
    try {
      fs.unlinkSync(staleClose);
    } catch (err) {
      logger.warn(
        { folder: group.folder, sessionName, err },
        'Failed to clear stale _close sentinel before container spawn',
      );
    }
  }
  if (isTrustedIpc) {
    fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  }

  // Chown IPC dirs so container user can read/write/unlink files
  const ipcUid = HOST_UID ?? 1000;
  const ipcGid = HOST_GID ?? 1000;
  if (ipcUid !== 0) {
    try {
      const subsToChown = isTrustedIpc
        ? ['', 'messages', 'tasks', sessionInputSubdir]
        : ['messages', sessionInputSubdir];
      for (const sub of subsToChown) {
        fs.chownSync(path.join(groupIpcDir, sub), ipcUid, ipcGid);
      }
    } catch (err) {
      logger.warn({ folder: group.folder, err }, 'Failed to chown IPC dirs');
    }
  }

  if (isTrustedIpc) {
    // Trusted/main: mount the whole IPC dir at /workspace/ipc, then overlay
    // the per-session input dir onto /workspace/ipc/input. Docker applies
    // nested bind mounts in order — the second mount replaces the dir entry
    // from the first, giving the container a session-isolated input/ while
    // the shared messages/tasks/ and IPC root files remain aggregated.
    mounts.push({
      hostPath: toHostPath(groupIpcDir),
      containerPath: '/workspace/ipc',
      readonly: false,
    });
    mounts.push({
      hostPath: toHostPath(sessionInputDir),
      containerPath: '/workspace/ipc/input',
      readonly: false,
    });
  } else {
    // Untrusted: split mounts — messages/ writable, input/ read-only, no tasks/.
    // Per-session input dir isolates _close sentinels between sessions.
    mounts.push({
      hostPath: toHostPath(path.join(groupIpcDir, 'messages')),
      containerPath: '/workspace/ipc/messages',
      readonly: false,
    });
    mounts.push({
      hostPath: toHostPath(sessionInputDir),
      containerPath: '/workspace/ipc/input',
      readonly: true,
    });
  }

  // Additional mounts validated against external allowlist
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

interface BuildContainerArgsResult {
  args: string[];
  // Always set — cleanup() is a no-op when no secret env-file was
  // written, so callers can invoke it unconditionally on container
  // exit without a null-check.
  cleanup: () => void;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  group: RegisteredGroup,
  isMain: boolean,
  replyToMessageId?: string,
  chatJid?: string,
  continuationCycleId?: string,
  isScheduledTask?: boolean,
): BuildContainerArgsResult {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Resource limits and filesystem restrictions for untrusted containers
  if (!isMain && !group.containerConfig?.trusted) {
    args.push(
      '--memory',
      '512m', // 512MB RAM hard limit
      '--memory-swap',
      '512m', // no swap
      '--cpus',
      '1', // 1 CPU core
      '--pids-limit',
      '256', // prevent fork bombs
      '--read-only', // immutable root filesystem
      '--tmpfs',
      '/tmp:size=64m', // writable /tmp via tmpfs (needed for input.json)
    );
    // Group folder is read-only for untrusted (set above).
    // Agent can read CLAUDE.md/skills but can't write 7GB of numbers.
  } else {
    // Trusted/main: cap memory to prevent host OOM when multiple containers
    // run in parallel. The NAS has 7.5GB RAM total; without a cap, multiple
    // Claude SDK processes can exhaust host memory and trigger kernel OOM
    // killer (SIGKILL exit 137). 1.5GB is plenty for Claude Code + skills.
    args.push(
      '--memory',
      '1536m', // 1.5GB RAM hard limit
      '--memory-swap',
      '2048m', // allow 512MB swap as buffer
    );
  }

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Credential tiers:
  //   Main/Trusted: scoped GITHUB_TOKEN (PAT, no admin) so the agent can
  //                 git fetch/pull/push over HTTPS and call the GitHub
  //                 REST API directly. The Bearer-header rewrite that
  //                 OneCLI does for the proxied Anthropic/Composio paths
  //                 doesn't bridge git's HTTP-Basic auth at the connection
  //                 level, which is why the token must be in-container
  //                 rather than proxy-injected. The PAT is fine-grained
  //                 and has no admin scope, so the in-container identity
  //                 cannot bypass branch protection or repo-admin ops
  //                 even though it matches the repo owner.
  //   Untrusted:    nothing — never receives GITHUB_TOKEN. The credential
  //                 helper baked into the image returns an empty password
  //                 in that case, and git-over-HTTPS fails the same way
  //                 it does today.
  //
  // Forwarded via the env-file mechanism (SECRET_CONTAINER_VARS +
  // buildSecretEnvFile) so the value never appears on the docker `-e`
  // command line where it could leak into process tables or logs.
  // COMPOSIO_API_KEY is retained in SECRET_CONTAINER_VARS even though
  // unused locally — preserves the upstream-merge surface.
  const containerEnvVars: string[] = ['GITHUB_TOKEN'];
  const secretEnv: Record<string, string> = {};
  if (isMain || group.containerConfig?.trusted === true) {
    for (const name of containerEnvVars) {
      const v = process.env[name];
      if (v && SECRET_CONTAINER_VARS.has(name)) {
        secretEnv[name] = v;
      }
    }
  }
  const secretFile = buildSecretEnvFile(secretEnv);
  if (secretFile) {
    args.push(...secretFile.args);
  }

  // Select which model + effort the agent-runner's SDK query() uses.
  // The runner reads `process.env.AGENT_MODEL` and `process.env.AGENT_EFFORT`
  // — see constants at the top of this file. Keeping these on the env
  // (not baked into the agent image) lets model bumps / effort retuning
  // ship with an orchestrator rebuild only.
  args.push('-e', `AGENT_MODEL=${AGENT_MODEL}`);
  args.push('-e', `AGENT_EFFORT=${AGENT_EFFORT}`);

  // SDK auto-compact working window (issue #29). Forwarded unconditionally:
  // the orchestrator's resolved AGENT_AUTO_COMPACT_WINDOW config (default
  // 800k) flows through to the SDK's CLAUDE_CODE_AUTO_COMPACT_WINDOW so
  // auto-compaction has ~200k of headroom on Opus's 1M window. Replaces
  // the previous 165k hardcode in the agent-runner.
  args.push(
    '-e',
    `CLAUDE_CODE_AUTO_COMPACT_WINDOW=${AGENT_AUTO_COMPACT_WINDOW}`,
  );

  // Pass chat JID so container scripts know which group they're in
  if (chatJid) {
    args.push('-e', `NANOCLAW_CHAT_JID=${chatJid}`);
  }

  // Pass reply-to message ID so the first IPC send_message appears as a Telegram reply
  if (replyToMessageId) {
    args.push('-e', `NANOCLAW_REPLY_TO_MESSAGE_ID=${replyToMessageId}`);
  }

  // Continuation marker for self-resuming cycles. Both env vars are
  // emitted together when the scheduled-task row carried a non-NULL
  // `continuation_cycle_id`; neither is emitted on a fresh invocation.
  // The calling skill checks both signals (env vars + the prompt
  // prefix it parses out of the task prompt) and fails closed to
  // "fresh invocation" if they disagree, so the env presence is
  // load-bearing — never paper over a missing value with a default.
  if (continuationCycleId) {
    args.push('-e', 'NANOCLAW_CONTINUATION=1');
    args.push('-e', `NANOCLAW_CONTINUATION_CYCLE_ID=${continuationCycleId}`);
  }

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // OneCLI gateway access for main + trusted containers (Google Calendar, Gmail, etc.)
  // OneCLI proxy injection. Trust tier controls which MCP tools the
  // agent-runner registers — the proxy itself is the same for everyone,
  // tier-gating happens client-side in onecli-mcp-stdio.ts based on
  // NANOCLAW_TRUST_TIER. The untrusted-security skill rules also forbid
  // the agent from issuing raw HTTP requests on user instruction in
  // untrusted contexts, so the MCP-tool surface is the practical
  // contract for what an untrusted container can reach.
  const oneCliEnv = readEnvFile([
    'ONECLI_AGENT_TOKEN',
    'ONECLI_ENABLE_SMARTTHINGS',
  ]);
  const oneCliAgentToken =
    process.env.ONECLI_AGENT_TOKEN || oneCliEnv.ONECLI_AGENT_TOKEN;
  // SmartThings is gated separately because device write tools have a
  // higher risk profile than read-mostly Calendar/Gmail. Operators
  // running OneCLI for gcal/gmail shouldn't get 8 physical-device
  // write tools as dead code behind the same gate. Set
  // ONECLI_ENABLE_SMARTTHINGS=1 in the host env / .env to opt in.
  const oneCliSmartThingsEnabled =
    process.env.ONECLI_ENABLE_SMARTTHINGS === '1' ||
    oneCliEnv.ONECLI_ENABLE_SMARTTHINGS === '1';
  const oneCliCa = `${process.env.HOME || os.homedir()}/.onecli/gateway-ca.pem`;
  const trustTier: 'main' | 'trusted' | 'untrusted' = isMain
    ? 'main'
    : group.containerConfig?.trusted === true
      ? 'trusted'
      : 'untrusted';
  if (oneCliAgentToken && fs.existsSync(oneCliCa)) {
    args.push('-e', `NANOCLAW_TRUST_TIER=${trustTier}`);
    // Dedicated activation flag for the agent-side OneCLI MCP server.
    // The server gates registration on NANOCLAW_ONECLI_ENABLED=1
    // rather than on HTTPS_PROXY presence, so that operators behind a
    // corporate proxy / mitmproxy don't accidentally activate the MCP
    // tools without an actual OneCLI gateway. Setting this here pairs
    // the activation with the proxy injection — both flip together.
    args.push('-e', 'NANOCLAW_ONECLI_ENABLED=1');
    if (oneCliSmartThingsEnabled) {
      args.push('-e', 'NANOCLAW_ONECLI_ENABLE_SMARTTHINGS=1');
    }
    const proxyUrl = `http://x:${oneCliAgentToken}@${CONTAINER_HOST_GATEWAY}:10255`;
    args.push('-e', `HTTPS_PROXY=${proxyUrl}`);
    args.push('-e', `HTTP_PROXY=${proxyUrl}`);
    args.push('-e', `https_proxy=${proxyUrl}`);
    args.push('-e', `http_proxy=${proxyUrl}`);
    // Skip proxy for the local credential proxy (Anthropic) and any localhost.
    // Hostname-only entries; port-suffix forms aren't reliably honored by
    // Node's undici EnvHttpProxyAgent. api.anthropic.com is INTENTIONALLY
    // NOT excluded: tools that use the anthropic SDK directly (e.g.
    // flightweather.py) can then route through OneCLI, which injects the
    // real Anthropic key via its stored secret. The Claude Agent SDK is
    // unaffected because it uses ANTHROPIC_BASE_URL=localhost:3001 (the
    // credential proxy) and goes through its own OAuth path.
    args.push('-e', `NO_PROXY=${CONTAINER_HOST_GATEWAY},127.0.0.1,localhost`);
    args.push('-e', `no_proxy=${CONTAINER_HOST_GATEWAY},127.0.0.1,localhost`);
    // NOTE: ANTHROPIC_API_KEY is intentionally NOT set at container scope.
    // Setting it would make the Claude Agent SDK choose api-key mode over
    // OAuth, breaking Claude Code's auth (it expects to do OAuth via the
    // credential proxy at localhost:3001). 3rd-party tools that need a
    // dummy key value to start (e.g. flightweather.py) should set it
    // locally in their own invocation — see flightweather-via-onecli.sh.
    args.push('-e', 'NODE_USE_ENV_PROXY=1');
    args.push('-e', 'NODE_EXTRA_CA_CERTS=/etc/onecli/ca.pem');
    args.push('-e', 'SSL_CERT_FILE=/etc/onecli/ca.pem');
    args.push('-e', 'CURL_CA_BUNDLE=/etc/onecli/ca.pem');
    args.push('-e', 'REQUESTS_CA_BUNDLE=/etc/onecli/ca.pem');
    args.push('-v', `${oneCliCa}:/etc/onecli/ca.pem:ro`);
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // In DooD, process.getuid() returns the orchestrator container's uid (1000),
  // not the actual host user. HOST_UID/HOST_GID override this.
  const effectiveUid = HOST_UID ?? process.getuid?.();
  const effectiveGid = HOST_GID ?? process.getgid?.();
  if (effectiveUid != null && effectiveUid !== 0 && effectiveUid !== 1000) {
    args.push('--user', `${effectiveUid}:${effectiveGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  // For scheduled tasks running in trusted/main containers, forward
  // third-party API keys and other non-sensitive vars from the host .env
  // file. Untrusted containers receive nothing — no trust, no env. Bot
  // tokens and SDK credentials are excluded via BLOCKED_TASK_ENV_VARS so
  // scripts can't bypass MCP or the credential proxy.
  //
  // Vars are forwarded via a 0600 tempfile (same mechanism as
  // SECRET_CONTAINER_VARS) so values never appear in `docker ps` / proc
  // command-line output. The tempfile is deleted after container spawn by
  // the returned cleanup() callback.
  //
  // This resolves issue #18: without this, scripts that read API keys from
  // os.environ silently fell back to degraded backends (OSRM instead of
  // Google Routes, etc.) because the scheduled-task shell was non-interactive
  // and never sourced .env through any profile hook.
  const isTrustedOrMain = isMain || !!group.containerConfig?.trusted;
  let taskEnvCleanup: (() => void) | null = null;
  if (isScheduledTask && isTrustedOrMain) {
    const taskEnv = readEnvFileAll(BLOCKED_TASK_ENV_VARS);
    const envFile = buildSecretEnvFile(taskEnv);
    if (envFile) {
      args.push(...envFile.args);
      taskEnvCleanup = envFile.cleanup;
    }
  }

  // Compose cleanup callbacks: PR #32 wires SECRET_CONTAINER_VARS env-file
  // (e.g. GITHUB_TOKEN) and PR #24 wires the scheduled-task .env-passthrough
  // env-file. Both materialize 0600 tempfiles that must be unlinked after
  // docker has consumed them. Each individual cleanup is idempotent, so we
  // can safely call both unconditionally.
  const secretCleanup = secretFile ? secretFile.cleanup : () => {};
  const composedCleanup =
    taskEnvCleanup === null
      ? secretCleanup
      : () => {
          secretCleanup();
          taskEnvCleanup!();
        };

  return {
    args,
    cleanup: composedCleanup,
  };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const sessionName = input.sessionName ?? DEFAULT_SESSION_NAME;

  // Clean up stale _reply_to file from previous container runs in THIS
  // session. The file must match the path the container reads — with
  // per-session input dirs the container's `/workspace/ipc/input/_reply_to`
  // maps to `<ipc>/<group>/input-<sessionName>/_reply_to`, so the cleanup
  // must target the same session-scoped path. A cleanup against the legacy
  // shared `input/` path would leave the real file in place, and a
  // scheduled task with no replyToMessageId would quote a random old
  // message from a prior run.
  const replyToFile = path.join(
    resolveGroupIpcPath(group.folder),
    sessionInputDirName(sessionName),
    '_reply_to',
  );
  try {
    fs.unlinkSync(replyToFile);
  } catch {
    /* file doesn't exist — fine */
  }

  const mounts = buildVolumeMounts(
    group,
    input.isMain,
    input.chatJid,
    sessionName,
  );
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  // Suffix the container name with sessionName (when non-default) so that
  // `docker ps` makes it obvious which slot a running container occupies.
  // Main-group parallelism means two containers can share the group folder;
  // the sessionName tag distinguishes them.
  const sessionSuffix =
    sessionName === DEFAULT_SESSION_NAME ? '' : `-${sessionName}`;
  const containerName = `nanoclaw-${safeName}${sessionSuffix}-${Date.now()}`;
  const { args: containerArgs, cleanup: cleanupSecretEnvFile } =
    buildContainerArgs(
      mounts,
      containerName,
      group,
      input.isMain,
      input.replyToMessageId,
      input.chatJid,
      input.continuationCycleId,
      input.isScheduledTask,
    );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) {
          logger.debug({ container: group.folder }, line);
          onAgentLine(group.folder, line);
        }
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    // Untrusted containers get shorter timeout (5 min vs 30 min default)
    const UNTRUSTED_TIMEOUT = 300_000;
    const defaultTimeout =
      input.isMain || group.containerConfig?.trusted
        ? CONTAINER_TIMEOUT
        : UNTRUSTED_TIMEOUT;
    const configTimeout = group.containerConfig?.timeout || defaultTimeout;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      // If the container has already produced output, the timeout is the
      // idle-cleanup branch — the turn finished, the container sat waiting
      // for more IPC, the idle window expired. That's normal lifecycle, not
      // an error. Only timeouts WITHOUT output indicate the agent hung.
      const isIdleCleanup = hadStreamingOutput;
      const logFn = isIdleCleanup ? logger.info : logger.error;
      logFn.call(
        logger,
        { group: group.name, containerName, idleCleanup: isIdleCleanup },
        isIdleCleanup
          ? 'Container idle-timeout cleanup, stopping gracefully'
          : 'Container timeout with no output, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      // Remove the secret env-file (if any) as soon as docker has
      // exited — the file's only consumer is the docker daemon at
      // spawn time, so the window of exposure ends with the close
      // event. cleanup() is idempotent; the error handler below
      // calls it too in case `close` is skipped (spawn ENOENT etc).
      cleanupSecretEnvFile();
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      // Spawn-error path: docker may never have read the env-file
      // (e.g. ENOENT on the docker binary itself), but the file is
      // still on disk. cleanup() is idempotent — safe to call here
      // and again from `close` if both fire.
      cleanupSecretEnvFile();
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
  isTrusted?: boolean,
): void {
  // Untrusted containers don't get IPC root files — tasks/ not mounted
  if (!isMain && !isTrusted) return;

  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
  containerConfig?: import('./types.js').RegisteredGroup['containerConfig'];
  requiresTrigger?: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
  isTrusted?: boolean,
): void {
  // Untrusted containers don't get IPC root files — available_groups not mounted
  if (!isMain && !isTrusted) return;

  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');

  // Preserve JID-keyed entries that agents may have written
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(groupsFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(groupsFile, 'utf-8'));
    } catch {
      existing = {};
    }
  }

  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        ...existing,
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
