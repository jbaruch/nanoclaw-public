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
export const HOST_UID = process.env.HOST_UID
  ? parseInt(process.env.HOST_UID, 10)
  : undefined;
export const HOST_GID = process.env.HOST_GID
  ? parseInt(process.env.HOST_GID, 10)
  : undefined;

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

// Model context window in tokens. Used as a soft upper bound on
// AGENT_AUTO_COMPACT_WINDOW so an operator typo (extra zero) doesn't
// silently push the SDK's auto-compact past the model's real ceiling.
// Default 1,000,000 matches the Opus 1M context tier this fork runs on
// by default. Override via MODEL_CONTEXT_WINDOW env var if running a
// different model family.
export const MODEL_CONTEXT_WINDOW = parseInt(
  process.env.MODEL_CONTEXT_WINDOW || '1000000',
  10,
);

// SDK auto-compact working window in tokens (issue #29). Forwarded to
// the agent-runner as `CLAUDE_CODE_AUTO_COMPACT_WINDOW` so the SDK's
// auto-compact resolver clamps `min(model_default, this)` and uses it
// as the working window before triggering a compaction pass.
//
// Default 800,000 leaves ~200k of compaction headroom on the 1M Opus
// window. The previous hardcode of 165,000 (carried over from upstream
// `qwibitai/nanoclaw@f77f9ce`) capped real-world heartbeat cycles at
// ~16% of the paid-for context window — see #29.
//
// Validation: a non-numeric / non-positive value would forward as
// `NaN`, which the SDK silently falls back from to its model default —
// so the blast radius is limited, but a stderr warning surfaces
// operator typos at startup rather than at first `query()` deep in
// runtime. We use `process.stderr.write` (not `logger.warn`) because
// config.ts is below logger.ts in the import graph and a logger import
// would close a circular dep through host-logs.ts.
const DEFAULT_AGENT_AUTO_COMPACT_WINDOW = 800_000;
function resolveAgentAutoCompactWindow(): number {
  const raw = process.env.AGENT_AUTO_COMPACT_WINDOW;
  if (!raw) return DEFAULT_AGENT_AUTO_COMPACT_WINDOW;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    process.stderr.write(
      `[config] AGENT_AUTO_COMPACT_WINDOW="${raw}" is not a positive integer — falling back to default ${DEFAULT_AGENT_AUTO_COMPACT_WINDOW}.\n`,
    );
    return DEFAULT_AGENT_AUTO_COMPACT_WINDOW;
  }
  if (parsed > MODEL_CONTEXT_WINDOW) {
    process.stderr.write(
      `[config] AGENT_AUTO_COMPACT_WINDOW=${parsed} exceeds MODEL_CONTEXT_WINDOW=${MODEL_CONTEXT_WINDOW} (likely an extra-zero typo) — falling back to default ${DEFAULT_AGENT_AUTO_COMPACT_WINDOW}.\n`,
    );
    return DEFAULT_AGENT_AUTO_COMPACT_WINDOW;
  }
  return parsed;
}
export const AGENT_AUTO_COMPACT_WINDOW = resolveAgentAutoCompactWindow();
