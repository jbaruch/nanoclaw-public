import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
  'TELEGRAM_BOT_POOL',
  'TILE_OWNER',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  envConfig.TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Docker-out-of-Docker: when the orchestrator runs inside a container,
// mount paths (-v) must reference the HOST filesystem, not the container's.
// Set HOST_PROJECT_ROOT in docker-compose.yml to the repo path on the host.
// When running directly on the host (e.g., Mac), this defaults to cwd().
export const HOST_PROJECT_ROOT = process.env.HOST_PROJECT_ROOT || PROJECT_ROOT;

// In DooD, process.getuid() returns the orchestrator container's uid (1000).
// HOST_UID/HOST_GID env vars override this with the actual host user's uid/gid.
//
// Validation: a set-but-malformed value (`HOST_UID=foo`, `-1`, `1.5`,
// `123abc`, or empty string) resolves to `undefined` here so
// downstream chown sites fall through to their default branch
// (Mac-host posture / chown to uid 1000) instead of forwarding the
// malformed value into `fs.chownSync` — `NaN` throws there, `-1`
// casts to uid 4294967295 and silently mis-owns. A stderr line
// surfaces the operator typo at startup; without it, the misconfig
// looks identical to "not running in DooD" and the original
// permission issue (#258) is invisible.
//
// Stderr is used directly rather than `logger` because this runs at
// module-evaluation time, before the orchestrator has wired any
// logger sinks. Stderr is always available and doesn't pull config
// into a tighter coupling with logger initialization order.
//
/**
 * @internal exported ONLY for `config.test.ts`. Re-importing the
 * module via `vi.resetModules()` to flip env values per case would
 * re-execute logger.ts each pass and leak
 * `process.on('uncaughtException')` / `unhandledRejection` handlers
 * (Node defaults to a max of 10 before warning). Direct invocation
 * with mutated `process.env` gives equivalent coverage of the
 * validation contract without the leak. `stripInternal: true` keeps
 * this out of generated `.d.ts` so the public API stays minimal.
 */
export function parseHostId(name: 'HOST_UID' | 'HOST_GID'): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  // Strict digits-only match: `parseInt` would silently accept partial
  // parses (`"123abc"` → 123, `"1.5"` → 1) and `!raw` would treat an
  // explicit empty string as "unset" — both shapes are operator typos
  // we want to surface, not absorb.
  if (!/^\d+$/.test(raw)) {
    process.stderr.write(
      `[config] ${name}="${raw}" is not a non-negative integer — ignoring; chowns to host user will fall back to default uid/gid.\n`,
    );
    return undefined;
  }
  return parseInt(raw, 10);
}
export const HOST_UID = parseHostId('HOST_UID');
export const HOST_GID = parseHostId('HOST_GID');

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH =
  process.env.MOUNT_ALLOWLIST_PATH ||
  path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH =
  process.env.SENDER_ALLOWLIST_PATH ||
  path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');

// Local paths for filesystem operations (mkdirSync, existsSync, etc.)
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`(?:^|\\s)${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Tile owner namespace for tessl registry (e.g., "jbaruch" → "jbaruch/nanoclaw-core")
export const TILE_OWNER =
  process.env.TILE_OWNER || envConfig.TILE_OWNER || 'nanoclaw';

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
