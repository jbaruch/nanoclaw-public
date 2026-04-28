import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  HOST_GID,
  HOST_UID,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TELEGRAM_BOT_POOL,
  TIMEZONE,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteAllSessions,
  deleteRegisteredGroup,
  deleteSession,
  deleteSessionName,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessageById,
  getMessagesSince,
  getTaskById,
  updateTask,
  createTask,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  updateGroupTrusted,
  updateGroupTrigger,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  DEFAULT_SESSION_NAME,
  GroupQueue,
  MAINTENANCE_SESSION_NAME,
} from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { initBotPool } from './channels/telegram.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { ChannelType } from './text-styles.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { pruneOldContainerLogs } from './host-logs.js';
import { startSessionCleanup } from './session-cleanup.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { installTelegramOutboundTap } from './telegram-outbound-tap.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

/** Check if a message is a reply to or quote of a bot message. */
function isReplyToBot(msg: NewMessage): boolean {
  // Check content prefix — resolveReply adds [Replying to SenderName: "..."]
  if (msg.content.startsWith(`[Replying to ${ASSISTANT_NAME}:`)) return true;
  // Check reply_to_message_id in DB — covers cases where prefix format differs
  if (msg.reply_to_message_id) {
    const original = getMessageById(msg.reply_to_message_id, msg.chat_jid);
    if (original?.is_from_me) return true;
  }
  return false;
}

let lastTimestamp = '';
// Nested by groupFolder → sessionName → sessionId. Tracks the user-facing
// `default` slot's SDK session chain so consecutive inbound messages
// resume the prior turn. `maintenance` entries may still be present here
// (e.g. loaded from persisted session state at startup, or written by a
// pre-#193 build), but scheduled tasks no longer update or resume that
// slot: they always start a fresh SDK turn (#193) to prevent cross-task
// `last_result` bleed, and the scheduler wipes their on-disk session
// artifacts (JSONL transcript + tool-results dir) immediately after
// each run completes.
let sessions: Record<string, Record<string, string>> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Per-chat reply-to tracking: updated when follow-up messages are piped,
// consumed by the output callback to quote-reply the latest message.
const pendingReplyTo: Record<string, string | undefined> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// Circuit breaker: pause groups that fail repeatedly to avoid burning credits.
const MAX_CONSECUTIVE_FAILURES = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const consecutiveFailures: Record<string, number> = {};
const circuitBreakerUntil: Record<string, number> = {};

// Per-folder timestamp of the most recent `nukeSession` call. Used to
// gate the post-spawn `setSession` writes against a race where a nuke
// fires while a container is still being awaited: the dying container
// emits a final SDK result containing the same `newSessionId` it was
// processing, and the completion handler would otherwise resurrect
// that row in the DB right after nuke deleted it. Resurrected row
// points at the JSONL file that nuke just wiped — every subsequent
// spawn reads the resurrected sessionId, the SDK can't load the
// transcript, and the chat wedges permanently. See #144 bug 1.
//
// Compare against the spawn's start timestamp captured BEFORE
// `runContainerAgent` is invoked: if `nukeTimestamps[folder] >=
// spawnStart`, the nuke landed after the spawn began (or
// concurrently), so any session-id write coming back from this
// container is stale and must be dropped.
const nukeTimestamps: Record<string, number> = {};

/**
 * Predicate: should the orchestrator clear the stored sessionId after
 * the agent-runner reported `output.error` and we have an active
 * `sessionId`?
 *
 * Trues on either of:
 * 1. Error strings the SDK / agent-runner produces when the JSONL
 *    transcript is missing or unloadable: `no conversation found`,
 *    `ENOENT.../<uuid>.jsonl`, `session ... not found`. These are
 *    the historical signals — kept verbatim to preserve the
 *    pre-existing recovery for crash-mid-write / disk-full cases.
 * 2. The token `error_during_execution` anywhere in the message —
 *    this is the SDK's result-message subtype that the agent-runner
 *    formats as `error_during_execution: <summary>` per #149's
 *    error-result recovery path. The previous regex missed this
 *    entirely, which is why #144's nuke-resurrected sessionId
 *    wedged chats: every spawn reproduced the same SDK error and
 *    nothing ever cleared the bad row from the DB.
 *
 * Exported for the unit test in `src/index.stale-session.test.ts`.
 *
 * @internal — call sites in this module are the only production
 *   consumers; the export is solely for test isolation.
 */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|error_during_execution/i;
export function isStaleSessionError(errorMsg: string | undefined): boolean {
  if (!errorMsg) return false;
  return STALE_SESSION_RE.test(errorMsg);
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

// The non-main heartbeat prompt delegates to the `check-unanswered`
// skill's two-phase workflow (SQL candidate filter + LLM reasoning
// over conversation context). Kept at module scope so the create path
// (registerGroup / syncNonMainHeartbeat) and the startup migration
// (syncNonMainHeartbeatPrompts) reference the same string — otherwise
// drift between them defeats the whole point of migrating.
const NON_MAIN_HEARTBEAT_PROMPT =
  'MANDATORY FIRST ACTION: Call Skill(skill: "tessl__check-unanswered") BEFORE doing anything else. Follow the skill\'s full two-phase workflow: the deterministic script finds candidate orphans, then LLM reasoning over the conversation-since context decides per candidate whether the bot already addressed it inline (react with 👍) or it genuinely needs a threaded reply. Do NOT skip the reasoning step — blind react+reply duplicates answers whenever the bot answered conversationally without threading. Do NOT query the database directly outside the skill. Do NOT check email, calendar, or system health.';

// Known old canonical strings that orchestrator versions emitted
// before the current `NON_MAIN_HEARTBEAT_PROMPT`. The startup
// migration ONLY rewrites rows whose prompt matches one of these —
// anything else (operator custom text, manual `update_task` via IPC
// for debugging, etc.) is left alone. A blanket
// `existing.prompt !== canonical` check would clobber customizations
// on every restart.
const LEGACY_NON_MAIN_HEARTBEAT_PROMPTS: ReadonlySet<string> = new Set([
  // v1: original shipped before the check-unanswered Phase-2 rewrite.
  'Run the check-unanswered script only: python3 /home/node/.claude/skills/tessl__check-unanswered/scripts/check-unanswered.py — then react and reply to each unanswered message. Do NOT query the database directly. Do NOT check email, calendar, or system health.',
  // v2: interim — English "Invoke the skill" phrasing, replaced by
  // the `Call Skill(...)` invocation pattern to match the main-group
  // heartbeat.
  'Invoke the `check-unanswered` skill and follow its full workflow. The skill runs the deterministic script to find candidate orphans, then does LLM reasoning over the conversation-since context to decide per candidate whether the bot already addressed it inline (react with 👍) or it genuinely needs a threaded reply. Do NOT skip the reasoning step — blind react+reply duplicates answers whenever the bot answered conversationally without threading. Do NOT query the database directly outside the skill. Do NOT check email, calendar, or system health.',
]);

// Path to the trusted-only unanswered-precheck script. Referenced by
// both the heartbeat-create path (`syncNonMainHeartbeat`) and the
// trust-flip reconciliation path (`setGroupTrusted`); kept as a
// constant so future edits can't drift between the two sites.
const UNANSWERED_PRECHECK_SCRIPT =
  'python3 /home/node/.claude/skills/tessl__check-unanswered/scripts/unanswered-precheck.py';

/**
 * Ensure a non-main group with explicit heartbeat opt-in has the correct
 * heartbeat task in the DB. Creates it if missing; otherwise, if the
 * stored prompt matches a KNOWN LEGACY version (see
 * `LEGACY_NON_MAIN_HEARTBEAT_PROMPTS`), rewrites just the prompt via
 * `updateTask`. Custom / unrecognised prompts are left alone — we
 * don't want to clobber an operator's manual tweak on every restart.
 *
 * Opt-in is `containerConfig.enableHeartbeat === true`. Pre-#158 this
 * fired automatically for every `requiresTrigger !== false` non-main
 * group, but no group has actually had `requires_trigger=1` in the DB,
 * so the auto-rule was dead code that would surprise-create a heartbeat
 * the moment somebody flipped the flag. Heartbeats are now explicit.
 *
 * Scope: only `prompt` is migrated for existing tasks. `schedule`,
 * `status`, and `next_run` are preserved as-is. The `script` field is
 * NOT touched here either — but trust-flip reconciliation for `script`
 * does happen elsewhere: `setGroupTrusted` (#105) updates the
 * heartbeat row's script when `containerConfig.trusted` flips, so
 * `precheckScript` stays in sync with the current trust tier without
 * requiring a heartbeat delete+recreate.
 *
 * Called from two places:
 *   - `registerGroup` (IPC register_group flow, when a group joins or
 *     re-registers — only if `enableHeartbeat` is set).
 *   - `syncNonMainHeartbeatPrompts` at startup (migrates the prompt of
 *     any non-main group that already has a heartbeat row, regardless
 *     of the current opt-in flag — preserves existing rows that
 *     pre-date #158).
 */
function syncNonMainHeartbeat(jid: string, group: RegisteredGroup): void {
  const heartbeatId = `heartbeat-${group.folder}`;
  const existingHeartbeat = getTaskById(heartbeatId);
  if (!existingHeartbeat) {
    // Pre-check gates the LLM, but it's only enabled for trusted
    // non-main groups for now because it needs to persist a seen-set
    // file and untrusted groups mount `/workspace/group` read-only.
    // Keep the precheck disabled there until the tracked fix (#72)
    // moves that state to a writable location.
    const precheckScript = group.containerConfig?.trusted
      ? UNANSWERED_PRECHECK_SCRIPT
      : undefined;
    createTask({
      id: heartbeatId,
      group_folder: group.folder,
      chat_jid: jid,
      prompt: NON_MAIN_HEARTBEAT_PROMPT,
      script: precheckScript,
      schedule_type: 'cron',
      schedule_value: '*/15 * * * *',
      // Heartbeats read every input from external sources (messages.db,
      // workspace, skills) on each tick — they have no use for
      // conversation continuity, and persisting the SDK session chain
      // bloats the JSONL monotonically. After 6 days of 15-min ticks
      // the swarm group's maintenance JSONL hit 187 MB and crossed the
      // AUP-classifier threshold, refusing every subsequent run (#114).
      // Single contaminated tick (poisoned tool_result, oversized image,
      // hung tool output) also gets persisted forever and re-read on
      // every later tick. `'isolated'` makes each tick a fresh session
      // — manual recovery becomes unnecessary because there's no
      // accumulated state to wipe.
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      created_by_role: 'owner',
    });
    logger.info(
      { jid, folder: group.folder },
      'Auto-created heartbeat for opted-in group',
    );
  } else if (
    existingHeartbeat.prompt !== NON_MAIN_HEARTBEAT_PROMPT &&
    LEGACY_NON_MAIN_HEARTBEAT_PROMPTS.has(existingHeartbeat.prompt)
  ) {
    // Prompt is a known legacy canonical — migrate it. Non-matching
    // prompts (operator customizations) are deliberately left alone.
    updateTask(heartbeatId, { prompt: NON_MAIN_HEARTBEAT_PROMPT });
    logger.info(
      { jid, folder: group.folder },
      'Migrated legacy non-main heartbeat prompt to current workflow',
    );
  }
}

/**
 * Startup migration: iterate every non-main group already in the DB
 * and migrate its heartbeat prompt IF one exists. Does NOT create
 * missing heartbeats — that's intentional. An operator who manually
 * deleted a heartbeat task (to disable automatic checks for a group)
 * would be thwarted every orchestrator restart if startup recreated
 * it. Creation stays bound to the register-group IPC flow with an
 * explicit `enableHeartbeat` opt-in (#158).
 *
 * Filter is just `!group.isMain` — the main group's heartbeat is
 * created and managed separately. Pre-#158 this also gated on
 * `requiresTrigger !== false`, but since the `requires_trigger` flag
 * never actually flipped on for any registered group, that check was
 * dead. Dropping it makes the migration purely "any existing non-main
 * heartbeat row gets its prompt updated", which is what callers
 * actually need: backward-compat for rows created by the old auto-rule.
 *
 * Handles the case where orchestrator code upgraded but the group
 * hasn't re-registered via IPC — without this, `syncNonMainHeartbeat`'s
 * drift check only fires on register_group events, which rarely happen
 * after initial setup.
 */
function syncNonMainHeartbeatPrompts(): void {
  // Delegate to `syncNonMainHeartbeat` for each non-main group that
  // already has a heartbeat task — DRY with the register-group code
  // path so a future edit to the migration logic can't silently
  // diverge. The existing-heartbeat guard ABOVE `syncNonMainHeartbeat`
  // here is what gives us "never re-create a deleted heartbeat" at
  // startup: if an operator deleted the row to disable automatic
  // checks for a group, this startup pass respects that and skips.
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.isMain) continue;
    const heartbeatId = `heartbeat-${group.folder}`;
    if (!getTaskById(heartbeatId)) continue; // don't recreate deleted heartbeats
    syncNonMainHeartbeat(jid, group);
  }
}

/**
 * Drift detector (#159): log every `registered_groups` row whose JID has
 * no matching `chats` row. The spawner reads `available_groups.json`
 * (which is rebuilt from `getAllChats()`) so a row missing from `chats`
 * is silently ignored at runtime — exactly the dormant-row failure mode
 * #159's one-shot cleanup addressed for `tg:1698969` / `telegram_main`.
 *
 * Read-only by design: future operator-introduced drift gets surfaced
 * for review (operator can resolve it via `unregister_group`) instead
 * of being auto-deleted at startup. Auto-delete would make recovery
 * from a transient `chats` outage (e.g. a partial DB restore that
 * truncated `chats` but kept `registered_groups`) catastrophic — every
 * registered group would vanish on the next restart.
 */
function logRegisteredGroupOrphans(): void {
  const knownJids = new Set(getAllChats().map((c) => c.jid));
  const orphans: Array<{ jid: string; folder: string }> = [];
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (knownJids.has(jid)) continue;
    orphans.push({ jid, folder: group.folder });
  }
  if (orphans.length > 0) {
    logger.warn(
      { orphans },
      'registered_groups rows have no matching chats row — invisible to the spawner. Run unregister_group to clean up if intended.',
    );
  }
}

/**
 * Delete the on-disk session artifacts (JSONL transcript and per-session
 * tool-results directory) for a given session slot, given the SDK
 * sessionId. Returns the number of filesystem entries actually removed —
 * up to 2 per slug (1 transcript + 1 tool-results dir) summed across
 * every project-slug subdirectory found.
 *
 * Path layout (host side):
 *   ${DATA_DIR}/sessions/<groupFolder>/<sessionName>/.claude/projects/<project-slug>/<sessionId>.jsonl
 *   ${DATA_DIR}/sessions/<groupFolder>/<sessionName>/.claude/projects/<project-slug>/<sessionId>/
 *
 * The project-slug is `-workspace-group` for our containers (see
 * CLAUDE_PROJECT_SLUG in container-runner.ts). We glob the projects/
 * directory rather than hardcoding the slug so a future change to the
 * slug — or any operator who renamed the workspace path — doesn't
 * silently leave stale artifacts behind.
 *
 * Used by `nukeSession` (#100) to actually wipe transcript state, and
 * by the scheduler's per-run finally (#193) to wipe scheduled-task
 * artifacts that aren't tracked in the sessions cache. Without this,
 * the next container spawn re-reads the JSONL and the bad state
 * (poison, stuck plan, corrupt memory) is immediately back, AND
 * orphan tool-results directories accumulate forever under the
 * maintenance slot.
 *
 * **Security**: `sessionId` ultimately originates from container stdout
 * (parsed `newSessionId` from the SDK's stream), which is *untrusted*
 * for untrusted-tier groups. A crafted value containing path separators
 * or `..` segments would otherwise be interpolated into the artifact
 * paths and could escape `projectsDir/<slug>/` to delete arbitrary
 * files or directories anywhere the orchestrator process can write.
 * Defense in depth:
 *   1. Reject anything that isn't a strict UUID-or-token charset.
 *   2. After joining, assert the resolved path stays inside `projectsDir`.
 *   3. The tool-results-dir helper additionally relies on Node's
 *      `fs.rmSync` not following symlinks during recursive removal,
 *      so a malicious container that scattered host-pointing symlinks
 *      inside its own dir cannot redirect the wipe outward.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Try to unlink `${slugPath}/${sessionId}.jsonl`. Returns 1 if the
 * filesystem entry was unlinked, 0 otherwise.
 *
 * Two paths depending on what `${sessionId}.jsonl` actually is:
 *
 *   - **Regular file**: dereference via `realpath` and verify it
 *     resolves inside `slugPath`'s realpath. This catches the TOCTOU
 *     case where a symlink ancestor of slugPath was swapped between
 *     the outer lstat and here, and would otherwise let an unlink
 *     escape the intended tree.
 *
 *   - **Symlink**: unlink the symlink itself. `fs.unlinkSync` on a
 *     symlink path removes the LINK, not the target — safe regardless
 *     of where the link points (including dangling). This is the
 *     "nuke really nukes" promise: if a compromised container makes
 *     the JSONL a symlink to dodge wipe, the symlink still goes away.
 *     Without this branch, the prior realpath-containment check would
 *     refuse to unlink a symlink-out-of-tree and leave the entry on
 *     disk — defeating the nuke entirely.
 *
 * Companion helper `removeToolResultsDirInSlug` mirrors this for the
 * sibling per-session tool-results directory at `${slugPath}/${sessionId}/`.
 */
function unlinkJsonlInSlug(
  slugPath: string,
  sessionId: string,
  groupFolder: string,
  sessionName: string,
): number {
  const jsonlPath = path.join(slugPath, `${sessionId}.jsonl`);

  // lstat first to learn what the entry actually is, without
  // following any symlink. This is the hinge for the two branches.
  let entryStat: fs.Stats;
  try {
    entryStat = fs.lstatSync(jsonlPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0; // no such jsonl — fine
    logger.warn(
      { err, groupFolder, sessionName, jsonlPath },
      'unlinkJsonlInSlug: lstat failed on jsonl — skipping',
    );
    return 0;
  }

  if (entryStat.isSymbolicLink()) {
    // Unlink the symlink itself. fs.unlinkSync removes the link
    // entry; it never deletes the target file the link points at.
    try {
      fs.unlinkSync(jsonlPath);
      logger.info(
        { groupFolder, sessionName, sessionId, jsonlPath },
        'unlinkJsonlInSlug: unlinked symlinked jsonl (target preserved)',
      );
      return 1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 0;
      logger.warn(
        { err, groupFolder, sessionName, sessionId, jsonlPath },
        'unlinkJsonlInSlug: unlink-of-symlink failed',
      );
      return 0;
    }
  }

  // Regular-file path: realpath containment check before unlink to
  // catch a slugPath ancestor symlink swap between the outer lstat
  // and here. `path.resolve` alone is string-based and wouldn't
  // notice such an escape.
  let realSlug: string;
  let realJsonl: string;
  try {
    realSlug = fs.realpathSync(slugPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    logger.warn(
      { err, groupFolder, sessionName, slugPath },
      'unlinkJsonlInSlug: realpath failed on slug — skipping',
    );
    return 0;
  }
  try {
    realJsonl = fs.realpathSync(jsonlPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    logger.warn(
      { err, groupFolder, sessionName, jsonlPath },
      'unlinkJsonlInSlug: realpath failed on jsonl — skipping',
    );
    return 0;
  }
  if (!realJsonl.startsWith(realSlug + path.sep)) {
    logger.warn(
      { groupFolder, sessionName, sessionId, jsonlPath, realSlug, realJsonl },
      'unlinkJsonlInSlug: refusing to unlink — realpath escapes slug directory',
    );
    return 0;
  }
  try {
    fs.unlinkSync(jsonlPath);
    return 1;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    logger.warn(
      { err, groupFolder, sessionName, sessionId, jsonlPath },
      'unlinkJsonlInSlug: unlink failed',
    );
    return 0;
  }
}

/**
 * Try to remove `${slugPath}/${sessionId}/` (the per-session tool-results
 * directory the SDK writes alongside `${sessionId}.jsonl`). Returns 1
 * if a filesystem entry was removed, 0 otherwise.
 *
 * Mirrors `unlinkJsonlInSlug` with the same lstat → branch on type →
 * realpath-containment discipline; only the leaf operation differs.
 *
 *   - **Symlink**: unlink the symlink itself. `fs.unlinkSync` removes
 *     the link entry without following it, so a compromised container
 *     can't redirect the wipe to walk into an arbitrary host directory
 *     and `recursive: true` it. Same "nuke really nukes" promise as
 *     the JSONL path.
 *
 *   - **Directory**: realpath the dir and the slug, verify the dir's
 *     real path is inside the slug's real path, then `fs.rmSync` with
 *     `recursive: true`. Node's `rmSync` does NOT traverse symlinks
 *     it encounters inside the tree — they're removed as link entries,
 *     never followed — so a malicious container that drops a symlink
 *     to `/etc` inside its own tool-results dir cannot trick us into
 *     deleting host files. The realpath check guards the parent path
 *     itself against ancestor-symlink swap (TOCTOU between the outer
 *     `wipeSessionJsonl` lstat and this call).
 *
 *   - **Regular file at the dir path**: not something the SDK writes,
 *     but if a compromised container plants one we leave it alone and
 *     log — wiping it would be outside the helper's contract (it's a
 *     directory remover) and could mask whatever produced the file.
 */
function removeToolResultsDirInSlug(
  slugPath: string,
  sessionId: string,
  groupFolder: string,
  sessionName: string,
): number {
  const dirPath = path.join(slugPath, sessionId);

  let entryStat: fs.Stats;
  try {
    entryStat = fs.lstatSync(dirPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    logger.warn(
      { err, groupFolder, sessionName, dirPath },
      'removeToolResultsDirInSlug: lstat failed — skipping',
    );
    return 0;
  }

  if (entryStat.isSymbolicLink()) {
    try {
      fs.unlinkSync(dirPath);
      logger.info(
        { groupFolder, sessionName, sessionId, dirPath },
        'removeToolResultsDirInSlug: unlinked symlinked tool-results dir (target preserved)',
      );
      return 1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 0;
      logger.warn(
        { err, groupFolder, sessionName, sessionId, dirPath },
        'removeToolResultsDirInSlug: unlink-of-symlink failed',
      );
      return 0;
    }
  }

  if (!entryStat.isDirectory()) {
    // The SDK only writes directories at this path. A regular file
    // here means something else put it there — leave it alone rather
    // than deleting state we can't account for.
    logger.warn(
      { groupFolder, sessionName, sessionId, dirPath },
      'removeToolResultsDirInSlug: refusing — entry exists but is neither symlink nor directory',
    );
    return 0;
  }

  // Directory path: realpath containment check before rm. Same TOCTOU
  // defense as the JSONL helper — a slugPath ancestor symlink swap
  // between the outer lstat and here would otherwise let `rmSync`
  // recurse into an unintended tree.
  let realSlug: string;
  let realDir: string;
  try {
    realSlug = fs.realpathSync(slugPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    logger.warn(
      { err, groupFolder, sessionName, slugPath },
      'removeToolResultsDirInSlug: realpath failed on slug — skipping',
    );
    return 0;
  }
  try {
    realDir = fs.realpathSync(dirPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    logger.warn(
      { err, groupFolder, sessionName, dirPath },
      'removeToolResultsDirInSlug: realpath failed on dir — skipping',
    );
    return 0;
  }
  if (!realDir.startsWith(realSlug + path.sep)) {
    logger.warn(
      { groupFolder, sessionName, sessionId, dirPath, realSlug, realDir },
      'removeToolResultsDirInSlug: refusing to remove — realpath escapes slug directory',
    );
    return 0;
  }
  try {
    // `recursive: true` walks the tree. Node never follows symlinks
    // inside — they're removed as entries — so a compromised container
    // that scattered symlinks to host paths in its own tool-results
    // tree cannot redirect the wipe.
    //
    // No `force: true`: we want ENOENT to surface as an error so the
    // returned count reflects actual removals. Without that distinction,
    // a concurrent cleanup that vanished the path between our lstat
    // and rmSync would still count as `1` here, inflating the caller's
    // "entries removed" total.
    fs.rmSync(dirPath, { recursive: true });
    return 1;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    logger.warn(
      { err, groupFolder, sessionName, sessionId, dirPath },
      'removeToolResultsDirInSlug: rmSync failed',
    );
    return 0;
  }
}

/**
 * Wipe the on-disk session artifacts (JSONL transcript and the
 * sibling per-session tool-results directory) for the given sessionId
 * across every project-slug subdirectory under the slot's `projects/`.
 * Returns the total number of filesystem entries removed.
 *
 * The function name retains the historical "Jsonl" suffix from when it
 * only unlinked transcripts; the contract is now a full session-artifact
 * wipe. Both artifact types share one realpath-containment regime, one
 * DoS-cap regime, and one slug-walk traversal — keeping them in a single
 * function avoids walking `projects/` twice for what is conceptually one
 * "wipe everything tied to this sessionId" operation.
 *
 * Production callers:
 *   1. `nukeSession` (#100) — owns the multi-step order-of-operations
 *      wipe (capture sessionIds → kill containers → drop DB rows →
 *      remove session artifacts).
 *   2. `startSchedulerLoop` (#193) — injects this as a dependency so
 *      `runTask`'s post-run finally can wipe the per-run artifacts the
 *      moment a scheduled run completes (its sessionId is never
 *      persisted to the DB, so the time-based `cleanup-sessions.sh`
 *      can't find them later).
 *
 * Tests also import this symbol directly to bypass the full
 * `nukeSession` path.
 *
 * @internal — the orchestrator builds with `tsconfig.stripInternal: true`,
 * so this tag keeps the symbol out of the emitted `.d.ts`. The two
 * production callers above are in-tree and don't need d.ts visibility;
 * tests reach the symbol through the source `.ts` import, not the d.ts.
 */
export function wipeSessionJsonl(
  groupFolder: string,
  sessionName: string,
  sessionId: string,
): number {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    logger.warn(
      { groupFolder, sessionName, sessionId },
      'wipeSessionJsonl: refusing to wipe — sessionId fails strict-charset check',
    );
    return 0;
  }

  const projectsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    sessionName,
    '.claude',
    'projects',
  );

  // Validate `projects/` BEFORE any unlink work — the fast path and
  // the slow walk both depend on it being a real directory inside
  // DATA_DIR, not a symlink swap pointing elsewhere. The per-session
  // `.claude` mount is writable from the container, so a compromised
  // container could replace `.claude/projects` with a symlink. We
  // refuse to traverse a symlinked `projects/` regardless of where
  // it points.
  let projectsLstat: fs.Stats;
  try {
    projectsLstat = fs.lstatSync(projectsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    logger.warn(
      { err, groupFolder, sessionName, sessionId, projectsDir },
      'wipeSessionJsonl: lstat failed on projects directory',
    );
    return 0;
  }
  if (projectsLstat.isSymbolicLink()) {
    logger.error(
      { groupFolder, sessionName, sessionId, projectsDir },
      'wipeSessionJsonl: refusing to traverse — projects/ itself is a symlink (possible escape attempt)',
    );
    return 0;
  }
  if (!projectsLstat.isDirectory()) {
    return 0;
  }

  // Try the well-known project slug FIRST as a fast path. Two wins:
  //   1. Defeats flood attacks where a compromised container fills
  //      `projects/` with millions of decoy slug-named subdirs to
  //      push the legitimate one past any walk cap. We hit the
  //      legitimate path directly and, on success, return without
  //      walking the tree at all.
  //   2. ~constant-time in the steady state — no opendir+iterate
  //      overhead per nuke.
  // The slow path (full walk) below is the safety net for cases
  // where the slug naming convention drifts (CLAUDE_PROJECT_SLUG
  // changes, operator-renamed workspace, etc.).
  let deleted = 0;
  const fastPathSlug = path.join(projectsDir, '-workspace-group');
  // Same lstat-then-skip discipline as the slow-path loop below
  // (line ~605): without this, a compromised container could replace
  // `projects/-workspace-group` with a symlink to an arbitrary host
  // directory. `unlinkJsonlInSlug`'s realpath-containment check
  // resolves BOTH the slug and the jsonl through the same symlink,
  // so the containment passes and the unlink lands inside the
  // symlink target.
  let fastPathLstat: fs.Stats | undefined;
  try {
    fastPathLstat = fs.lstatSync(fastPathSlug);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(
        { err, groupFolder, sessionName, sessionId, fastPathSlug },
        'wipeSessionJsonl: lstat failed on fast-path slug',
      );
    }
  }
  if (fastPathLstat?.isSymbolicLink()) {
    logger.error(
      { groupFolder, sessionName, sessionId, fastPathSlug },
      'wipeSessionJsonl: refusing fast path — slug is a symlink (possible escape attempt)',
    );
  } else if (fastPathLstat?.isDirectory()) {
    deleted += unlinkJsonlInSlug(
      fastPathSlug,
      sessionId,
      groupFolder,
      sessionName,
    );
    deleted += removeToolResultsDirInSlug(
      fastPathSlug,
      sessionId,
      groupFolder,
      sessionName,
    );
  }

  // Walk project-slug subdirectories with `opendirSync` — an
  // iterator-style API that does NOT materialize the full directory
  // listing up front, unlike `readdirSync`.
  //
  // Caps:
  //   - MAX_DIRS_VISITED bounds the slow-path search across many
  //     project slugs. Stray files don't count.
  //   - MAX_TOTAL_ENTRIES bounds total readSync iterations so a
  //     `projects/` filled with millions of stub FILES can't block
  //     the orchestrator event loop synchronously.
  const MAX_DIRS_VISITED = 10000;
  const MAX_TOTAL_ENTRIES = 100000;

  // TOCTOU defense for the parent dir: realpath after opendir.
  // `fs.Dir` doesn't expose its FD, so we can't fstat the open handle
  // — instead we resolve the path through the symlink chain at this
  // moment. If a compromised container swapped `projects/` to a
  // symlink between our lstat above and the opendirSync below, the
  // realpath result will land outside the expected `<DATA_DIR>/...`
  // tree and we abort. Residual race: a container would have to win
  // a sub-millisecond inode swap AND aim it inside DATA_DIR — at
  // which point it has already broken out of its sandbox and the
  // orchestrator has bigger problems. Per-slug realpath checks below
  // catch escape attempts at the leaf level regardless.
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(projectsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return deleted;
    logger.warn(
      { err, groupFolder, sessionName, sessionId, projectsDir },
      'wipeSessionJsonl: failed to open projects directory',
    );
    return deleted;
  }
  try {
    const realProjects = fs.realpathSync(projectsDir);
    // Also realpath DATA_DIR to handle macOS where /var → /private/var
    // (or similar OS-level symlinks). Without this both sides could
    // dereference to different absolute prefixes and the prefix check
    // would false-positive even on a perfectly legitimate path.
    const realDataDir = fs.realpathSync(DATA_DIR);
    const expectedPrefix = realDataDir + path.sep;
    if (!realProjects.startsWith(expectedPrefix)) {
      logger.error(
        {
          groupFolder,
          sessionName,
          sessionId,
          projectsDir,
          realProjects,
          expectedPrefix,
        },
        'wipeSessionJsonl: projects/ realpath outside DATA_DIR — aborting (TOCTOU?)',
      );
      dir.closeSync();
      return deleted;
    }
  } catch (err) {
    logger.warn(
      { err, groupFolder, sessionName, sessionId, projectsDir },
      'wipeSessionJsonl: realpath on projects/ failed — aborting',
    );
    dir.closeSync();
    return deleted;
  }

  let dirsVisited = 0;
  let totalEntries = 0;
  let bailedOnLimit: 'total-entries' | 'dirs-visited' | null = null;
  try {
    let entry: fs.Dirent | null;
    while ((entry = dir.readSync()) !== null) {
      totalEntries++;
      if (totalEntries > MAX_TOTAL_ENTRIES) {
        bailedOnLimit = 'total-entries';
        break;
      }
      // Skip the slug we already tried in the fast path — would
      // double-count `deleted` if the file was already gone.
      if (entry.name === '-workspace-group') continue;

      const slugPath = path.join(projectsDir, entry.name);
      let linkStat: fs.Stats;
      try {
        linkStat = fs.lstatSync(slugPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        logger.warn(
          { err, groupFolder, sessionName, slugPath },
          'wipeSessionJsonl: lstat failed on slug entry — skipping',
        );
        continue;
      }
      if (linkStat.isSymbolicLink()) {
        logger.warn(
          { groupFolder, sessionName, slugPath },
          'wipeSessionJsonl: refusing to traverse symlink under projects/',
        );
        continue;
      }
      if (!linkStat.isDirectory()) continue;

      dirsVisited++;
      if (dirsVisited > MAX_DIRS_VISITED) {
        bailedOnLimit = 'dirs-visited';
        break;
      }

      deleted += unlinkJsonlInSlug(
        slugPath,
        sessionId,
        groupFolder,
        sessionName,
      );
      deleted += removeToolResultsDirInSlug(
        slugPath,
        sessionId,
        groupFolder,
        sessionName,
      );
    }
  } finally {
    dir.closeSync();
  }

  if (bailedOnLimit === 'total-entries') {
    logger.error(
      {
        groupFolder,
        sessionName,
        sessionId,
        totalEntries,
        limit: MAX_TOTAL_ENTRIES,
        deleted,
      },
      'wipeSessionJsonl: stopped early — total readSync count exceeded MAX_TOTAL_ENTRIES (possible DoS via stub-file flood)',
    );
  } else if (bailedOnLimit === 'dirs-visited') {
    logger.error(
      {
        groupFolder,
        sessionName,
        sessionId,
        dirsVisited,
        limit: MAX_DIRS_VISITED,
        deleted,
      },
      'wipeSessionJsonl: stopped early — directory-traversal count exceeded MAX_DIRS_VISITED (possible DoS via slug-dir flood)',
    );
  }
  return deleted;
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // CLAUDE.md is no longer copied per-group — it's a thin trust-tier
  // pointer mounted readonly by container-runner.ts at spawn time, so
  // the trust flag at the moment of spawn picks the right template
  // every time (fixes #153 by construction). The agent's mutable
  // per-group memory lives in MEMORY.md; create an empty placeholder
  // here so the @import in CLAUDE.md resolves on the very first
  // message instead of the agent seeing a missing file.
  const memoryMdFile = path.join(groupDir, 'MEMORY.md');
  if (!fs.existsSync(memoryMdFile)) {
    fs.writeFileSync(
      memoryMdFile,
      `# Memory — ${group.name || group.folder}\n\n` +
        '_Persistent notes the agent has accumulated about this group. ' +
        'Append facts the agent should recall in future sessions._\n',
    );
    logger.info({ folder: group.folder }, 'Created empty MEMORY.md for group');
  }

  // Chown group folder to the container user so the agent can write to it.
  // In DooD the orchestrator runs as root — files it creates are root-owned.
  const effectiveUid = HOST_UID ?? process.getuid?.();
  const effectiveGid = HOST_GID ?? process.getgid?.();
  if (effectiveUid != null && effectiveUid !== 0) {
    try {
      chownRecursive(groupDir, effectiveUid, effectiveGid ?? effectiveUid);
    } catch (err) {
      logger.warn(
        { folder: group.folder, err },
        'Failed to chown group folder',
      );
    }
  }

  // Heartbeat for non-main groups is opt-in via
  // `containerConfig.enableHeartbeat`. Pre-#158 this auto-fired for every
  // `requiresTrigger !== false` non-main group, but no group has ever
  // had `requires_trigger=1` in the DB — the rule was dormant dead code
  // that would have surprise-created a heartbeat the moment somebody
  // flipped that flag. Heartbeat is now an explicit, visible config
  // choice rather than a side-effect of trigger configuration.
  //
  // Strict `=== true` because containerConfig parses from unvalidated
  // JSON via parseContainerConfig — a non-boolean truthy value (e.g. the
  // string "true" from a hand-edited row) would otherwise create a
  // surprise heartbeat. Documented as boolean-only, enforced here.
  if (group.containerConfig?.enableHeartbeat === true && !group.isMain) {
    syncNonMainHeartbeat(jid, group);
  }

  // Auto-create the parallel-maintenance heartbeat for every main group.
  // Mirrors the non-main auto-registration above, but runs in the
  // `maintenance` session slot so it doesn't block user-facing Andy.
  // The task-scheduler fires this every 15 minutes via
  // `MAINTENANCE_SESSION_NAME`; the prompt keeps the defensive preamble
  // as belt-and-suspenders against improvisation.
  if (group.isMain) {
    const heartbeatId = `heartbeat-${group.folder}`;
    if (!getTaskById(heartbeatId)) {
      createTask({
        id: heartbeatId,
        group_folder: group.folder,
        chat_jid: jid,
        prompt:
          'MANDATORY FIRST ACTION: Call Skill(skill: "tessl__heartbeat") BEFORE doing anything else. Do NOT improvise checks. Do NOT query databases. Do NOT invent thresholds. Load and execute the skill exactly as written.\n\n' +
          'This is a scheduled heartbeat — no ACK reaction, no reply_to.\n' +
          'Workspace: /workspace/group/\n' +
          'Telegram HTML ONLY: <b>, <i>, <code>, <a href="url">text</a>, • for bullets. NEVER Markdown.\n' +
          'CRITICAL: NEVER set the "sender" parameter on send_message. Always call send_message with only "text" and optionally "pin". The sender parameter routes through pool bots and bypasses the database — messages become ghosts.\n' +
          'If nothing actionable → produce NO output at all. Silence = success.',
        schedule_type: 'interval',
        schedule_value: '900000', // 15 minutes in ms
        // See `syncNonMainHeartbeat` above for the full rationale —
        // heartbeats are stateless by design (every input read from
        // external sources on each tick), persisting the session chain
        // is pure liability (#114). Same fix on both heartbeat-create
        // sites so the orchestrator's two paths can't drift.
        context_mode: 'isolated',
        next_run: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
        created_by_role: 'owner',
      });
      logger.info(
        { jid, folder: group.folder },
        'Auto-created maintenance heartbeat for main group',
      );
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function chownRecursive(dir: string, uid: number, gid: number): void {
  fs.chownSync(dir, uid, gid);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    fs.chownSync(fullPath, uid, gid);
    if (entry.isDirectory()) {
      chownRecursive(fullPath, uid, gid);
    }
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
      containerConfig: registeredGroups[c.jid]?.containerConfig,
      requiresTrigger: registeredGroups[c.jid]?.requiresTrigger,
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  let group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  // Circuit breaker: skip groups that have failed too many times in a row
  const breakerExpiry = circuitBreakerUntil[group.folder];
  if (breakerExpiry) {
    if (Date.now() < breakerExpiry) {
      logger.warn({ group: group.name }, 'Circuit breaker active — skipping');
      return true;
    }
    // Cooldown expired — reset and let the group try again
    delete circuitBreakerUntil[group.folder];
    consecutiveFailures[group.folder] = 0;
    logger.info(
      { group: group.name },
      'Circuit breaker cooldown expired — resuming',
    );
  }

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: getTriggerPattern(group.trigger),
    timezone: TIMEZONE,
    deps: {
      sendMessage: async (text) => {
        await channel.sendMessage(chatJid, text);
      },
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = getTriggerPattern(group.trigger).test(
          msg.content.trim(),
        );
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        (triggerPattern.test(m.content.trim()) || isReplyToBot(m)) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing container stdin',
        );
        queue.closeStdin(chatJid);
      },
      group.isMain || group.containerConfig?.trusted ? IDLE_TIMEOUT : 300_000,
    );
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Progressive streaming disabled — causes message override bugs when
  // multiple messages are piped to the same container.

  // Track which message triggered the response — first reply quotes it.
  // Uses shared pendingReplyTo map so follow-up messages piped via
  // queue.sendMessage() can update the reply target for the output callback.
  pendingReplyTo[chatJid] = missedMessages[missedMessages.length - 1]?.id;
  logger.info(
    {
      replyToMessageId: pendingReplyTo[chatJid],
      messageIds: missedMessages.map((m) => m.id),
      group: group.name,
    },
    'Reply-to tracking',
  );

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          const replyId = pendingReplyTo[chatJid];
          const sendResult = await channel.sendMessage(chatJid, text, replyId);
          // Normalize `string | void` to `string | undefined`; only
          // persist a telegram_message_id when we actually got one.
          const sentMsgId =
            typeof sendResult === 'string' ? sendResult : undefined;
          // Store bot response in DB so heartbeat can track answered messages.
          // Stamp `telegram_message_id` (last chunk's Telegram ID on multi-
          // chunk sends) so post-hoc "which bot send corresponds to Telegram
          // message X" queries work — the synthetic `bot-*` id alone makes
          // that a logs-grep exercise.
          storeMessage({
            id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            chat_jid: chatJid,
            sender: ASSISTANT_NAME,
            sender_name: ASSISTANT_NAME,
            content: text,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
            reply_to_message_id: replyId,
            telegram_message_id: sentMsgId,
          });
          // Consume after first reply — prevents replying to the wrong message
          // when user sends follow-ups while background agent is working.
          pendingReplyTo[chatJid] = undefined;
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    pendingReplyTo[chatJid],
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // Track consecutive failures for circuit breaker
    consecutiveFailures[group.folder] =
      (consecutiveFailures[group.folder] || 0) + 1;
    if (consecutiveFailures[group.folder] >= MAX_CONSECUTIVE_FAILURES) {
      circuitBreakerUntil[group.folder] =
        Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      logger.error(
        { group: group.name, failures: consecutiveFailures[group.folder] },
        `Circuit breaker tripped — pausing group for ${CIRCUIT_BREAKER_COOLDOWN_MS / 60_000} minutes`,
      );
      // Notify via main group if this isn't the main group
      if (!isMainGroup) {
        const mainJid = Object.keys(registeredGroups).find(
          (jid) => registeredGroups[jid].isMain,
        );
        if (mainJid) {
          const mainChannel = findChannel(channels, mainJid);
          mainChannel?.sendMessage(
            mainJid,
            `Circuit breaker tripped for "${group.name}" — ${consecutiveFailures[group.folder]} consecutive failures. Paused for 30 minutes. Check logs.`,
          );
        }
      }
    }

    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // Reset failure counter on success
  consecutiveFailures[group.folder] = 0;
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  replyToMessageId?: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  // User-facing path always uses the `default` slot's session chain.
  const sessionId = sessions[group.folder]?.[DEFAULT_SESSION_NAME];

  // Capture the spawn-start wall clock BEFORE any container work
  // begins. The two `setSession` writes below (the streaming
  // wrappedOnOutput and the post-completion handler) compare this
  // against `nukeTimestamps[group.folder]` to detect a nuke that
  // landed mid-spawn — the dying container's last SDK result still
  // carries the now-defunct `newSessionId`, and writing it back to
  // the DB would resurrect a row whose JSONL was just wiped. See
  // #144 bug 1 for the failure mode (every subsequent spawn reads
  // the resurrected row, fails to load the missing transcript, and
  // wedges the chat permanently).
  const spawnStart = Date.now();
  const wasNukedDuringSpawn = (): boolean =>
    (nukeTimestamps[group.folder] ?? 0) >= spawnStart;

  // Update tasks snapshot for container to read (filtered by group)
  const isTrusted = !!group.containerConfig?.trusted;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
    isTrusted,
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
    isTrusted,
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          if (wasNukedDuringSpawn()) {
            logger.warn(
              {
                group: group.name,
                staleSessionId: output.newSessionId,
                nukeAt: nukeTimestamps[group.folder],
                spawnStart,
              },
              'Dropping streaming setSession write — nuke fired during spawn (#144)',
            );
          } else {
            if (!sessions[group.folder]) sessions[group.folder] = {};
            sessions[group.folder][DEFAULT_SESSION_NAME] = output.newSessionId;
            setSession(group.folder, DEFAULT_SESSION_NAME, output.newSessionId);
          }
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        isTrusted: !!group.containerConfig?.trusted,
        assistantName: ASSISTANT_NAME,
        replyToMessageId,
        // User-facing path. Invariant: inbound messages always route to
        // `default`. `src/task-scheduler.ts` is the sole writer of
        // `'maintenance'` — maintenance-Andy never reaches this code path.
        sessionName: DEFAULT_SESSION_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(
          chatJid,
          DEFAULT_SESSION_NAME,
          proc,
          containerName,
          group.folder,
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      if (wasNukedDuringSpawn()) {
        logger.warn(
          {
            group: group.name,
            staleSessionId: output.newSessionId,
            nukeAt: nukeTimestamps[group.folder],
            spawnStart,
          },
          'Dropping post-completion setSession write — nuke fired during spawn (#144)',
        );
      } else {
        if (!sessions[group.folder]) sessions[group.folder] = {};
        sessions[group.folder][DEFAULT_SESSION_NAME] = output.newSessionId;
        setSession(group.folder, DEFAULT_SESSION_NAME, output.newSessionId);
      }
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry
      // starts fresh. The session .jsonl can go missing after a crash
      // mid-write, manual deletion, disk-full, or — most critically
      // for this codebase — after the #144 race wrote a stale
      // sessionId back to the DB pointing at a JSONL that nuke had
      // already wiped. The existing backoff in group-queue.ts handles
      // the retry; we just need to remove the broken session ID.
      //
      // The regex covers the SDK's two reporting shapes:
      // 1. Thrown / re-formatted into the error string by the SDK or
      //    the agent-runner (e.g. "no conversation found", "ENOENT
      //    /workspace/.claude/projects/.../<uuid>.jsonl", "session
      //    not found").
      // 2. SDK result-message error subtypes that the agent-runner
      //    formats as `<subtype>: <summary>` per #149's recovery path
      //    (e.g. "error_during_execution: ..."). The
      //    `error_during_execution` token is the dominant signal that
      //    a session pointer is broken — the SDK uses it whenever
      //    transcript load fails for ANY reason, and the previous
      //    regex missed it entirely. Per #144 bug 2.
      const isStaleSession = !!sessionId && isStaleSessionError(output.error);

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        // Only clear the DEFAULT slot — this path runs the user-facing
        // container, so a stale session here is default's problem, not
        // maintenance's. Wiping both would force maintenance to restart
        // its own session chain for no reason.
        if (sessions[group.folder])
          delete sessions[group.folder][DEFAULT_SESSION_NAME];
        deleteSessionName(group.folder, DEFAULT_SESSION_NAME);
      } else if (sessionId && output.error) {
        // Drift surface (#155): we had a sessionId AND an error, but
        // the predicate didn't match. Either the error genuinely isn't
        // a stale-session signal (model rate limit, OAuth, etc.) — fine —
        // or the SDK changed its wording and the regex needs an update.
        // Debug-level so steady-state noise stays low; an operator who
        // sees recovery stop working can flip the log level and the
        // unmatched string surfaces immediately.
        logger.debug(
          { group: group.name, error: output.error },
          'Container error did not match stale-session predicate (no sessionId clear)',
        );
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) =>
              extractSessionCommand(
                m.content,
                getTriggerPattern(group.trigger),
              ) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                (triggerPattern.test(m.content.trim()) || isReplyToBot(m)) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          const lastMsgId = messagesToSend[messagesToSend.length - 1]?.id;
          if (queue.sendMessage(chatJid, formatted, lastMsgId)) {
            // Update shared reply-to so the output callback quotes this message
            pendingReplyTo[chatJid] = lastMsgId;
            logger.debug(
              {
                chatJid,
                count: messagesToSend.length,
                replyToMessageId: lastMsgId,
              },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  // Install the outbound-Telegram HTTP tap FIRST — before any grammy Bot,
  // credential proxy, or channel loads. The tap wraps `fetch`, `http/https`
  // `request`, and `child_process.spawn/exec/execFile` to log any outbound
  // call to `api.telegram.org` regardless of which in-process code path
  // originates it. Gated on `LOG_LEVEL=debug` (same as #87's transformer);
  // no overhead at `info` or higher. See `telegram-outbound-tap.ts`.
  installTelegramOutboundTap();
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    if (!msg.is_from_me) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: sender is not the account owner',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Initialize Telegram bot pool for agent teams (swarm)
  if (TELEGRAM_BOT_POOL.length > 0) {
    await initBotPool(TELEGRAM_BOT_POOL);
  }

  // Prompt-drift migration MUST run before the scheduler starts.
  // `startSchedulerLoop` below kicks off its first `loop()` immediately,
  // and if any non-main heartbeat has `next_run <= now` from orchestrator
  // downtime, it'll dispatch with the OLD prompt before the migration
  // gets a chance to rewrite it. Running the sync first makes the first
  // post-deploy heartbeat use the current canonical prompt.
  syncNonMainHeartbeatPrompts();

  // Surface registered-but-invisible-to-spawner rows (#159) at startup
  // so we notice future drift instead of growing dormant rows silently.
  logRegisteredGroupOrphans();

  // Start subsystems (independently of connection handler).
  // Scheduled tasks run through the shared queue under the parallel
  // `maintenance` slot, but they do NOT resume or persist an SDK session
  // chain across runs (#193). Each run gets a fresh sessionId; the
  // scheduler wipes the per-run on-disk artifacts (JSONL transcript +
  // tool-results dir) via `wipeSessionJsonl` once the run completes so
  // the per-slot `.claude/projects/` tree doesn't accumulate orphans.
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    queue,
    onProcess: (groupJid, sessionName, proc, containerName, groupFolder) =>
      queue.registerProcess(
        groupJid,
        sessionName,
        proc,
        containerName,
        groupFolder,
      ),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (text) await channel.sendMessage(jid, text);
    },
    wipeSessionJsonl,
  });
  startIpcWatcher({
    sendMessage: (jid, rawText, replyToMessageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (!text) return Promise.resolve();
      return channel.sendMessage(jid, text, replyToMessageId);
    },
    sendReaction: async (jid, messageId, emoji) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      if (messageId) {
        await channel.sendReaction?.(jid, messageId, emoji);
      } else {
        await channel.reactToLatestMessage?.(jid, emoji);
      }
    },
    pinMessage: async (jid, messageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      await channel.pinMessage?.(jid, messageId);
    },
    sendFile: async (jid, filePath, caption, replyToMessageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      await channel.sendFile?.(jid, filePath, caption, replyToMessageId);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    unregisterGroup: (jid) => {
      // Mirror DB delete into the in-memory registry so subsequent
      // routing decisions stop seeing the JID as registered before any
      // restart. Same site-of-truth pattern as setGroupTrusted /
      // setGroupTrigger above. Returns the DB delete's truthy-changes
      // result so the IPC handler can distinguish "actually removed"
      // from "wasn't there to begin with" — see #159.
      delete registeredGroups[jid];
      return deleteRegisteredGroup(jid);
    },
    setGroupTrusted: (jid, trusted) => {
      const updated = updateGroupTrusted(jid, trusted);
      if (!updated) return false;
      // Mirror DB change into the in-memory registry so subsequent
      // routing decisions see the new trust flag immediately, before any
      // restart. Without this, the agent would have to wait for the
      // orchestrator to reload from DB to see its own update.
      registeredGroups[jid] = updated;

      // Reconcile the heartbeat task's `script` field if one exists.
      // The unanswered-precheck only runs for trusted non-main groups
      // (untrusted mounts /workspace/group read-only and the precheck
      // needs to persist a seen-set file there — see #72). When trust
      // flips, the existing heartbeat row's script must follow, or
      // it'll keep running with the wrong precheck setting until the
      // operator manually edits the task. If no heartbeat exists
      // (operator deleted it to disable, or this is the main group)
      // we leave well alone — registerGroup is the sole path that
      // creates new heartbeats.
      if (!updated.isMain) {
        const heartbeatId = `heartbeat-${updated.folder}`;
        const heartbeat = getTaskById(heartbeatId);
        if (heartbeat) {
          const desiredScript = updated.containerConfig?.trusted
            ? UNANSWERED_PRECHECK_SCRIPT
            : null;
          if ((heartbeat.script ?? null) !== desiredScript) {
            updateTask(heartbeatId, { script: desiredScript });
            logger.info(
              { jid, folder: updated.folder, trusted, desiredScript },
              'setGroupTrusted: reconciled heartbeat task script for trust change',
            );
          }
        }
      }
      return true;
    },
    setGroupTrigger: (jid, trigger, requiresTrigger) => {
      const updated = updateGroupTrigger(jid, trigger, requiresTrigger);
      if (!updated) return false;
      registeredGroups[jid] = updated;
      // Heartbeat lifecycle is intentionally NOT touched here. Pre-#158
      // a flip to `requiresTrigger=true` would auto-create a heartbeat
      // and the inverse flip would log a warning. With heartbeat opt-in
      // via `containerConfig.enableHeartbeat`, trigger config and
      // heartbeat are orthogonal — operators change each independently.
      return true;
    },
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    nukeSession: (
      groupFolder: string,
      session: 'default' | 'maintenance' | 'all',
    ) => {
      // Stamp the nuke's wall-clock timestamp BEFORE doing any of the
      // wipe work — the in-flight spawn handler (runAgent) compares
      // this against its own pre-spawn timestamp to decide whether
      // the SDK result it just got is from a session that's since
      // been nuked. The Date.now() resolution + the
      // setSession-before-nuke sequence is robust against the race
      // observed in #144 bug 1 (concurrent setSession resurrected
      // a row that the same call had just deleted).
      nukeTimestamps[groupFolder] = Date.now();
      // Granular nuke: `session` narrows which slot(s) to kill.
      //   'all'         → kill default + maintenance (pre-parallel default)
      //   'default'     → kill only user-facing container
      //   'maintenance' → kill only scheduled-task container
      // Useful when one session is wedged (e.g. a hung heartbeat in
      // maintenance) and we don't want to drop the user's default
      // conversation state as collateral damage.
      //
      // Per #100, the nuke runs in four steps, in order:
      //   1. Capture the SDK sessionIds we're about to drop (before
      //      clearing them — once they're gone we can't find the
      //      on-disk artifacts).
      //   2. Kill the running container(s) so nothing keeps writing.
      //   3. Delete the session rows from the DB and clear in-memory.
      //   4. Delete the on-disk session artifacts (JSONL transcript
      //      and the per-session tool-results directory beside it).
      //
      // Without step 4, the next container spawn re-reads whatever poison
      // / stuck plan / corrupt state put the session in a bad state and
      // we're right back where we started — see #100 for the Gmail
      // invisible-Unicode incident that motivated this.
      const slotsToWipe: Array<'default' | 'maintenance'> =
        session === 'all'
          ? ['default', 'maintenance']
          : [
              session === 'default'
                ? DEFAULT_SESSION_NAME
                : MAINTENANCE_SESSION_NAME,
            ];
      const sessionIdsToWipe = new Map<string, string>();
      for (const slot of slotsToWipe) {
        const sid = sessions[groupFolder]?.[slot];
        if (sid) sessionIdsToWipe.set(slot, sid);
      }

      const jid =
        Object.entries(registeredGroups).find(
          ([, g]) => g.folder === groupFolder,
        )?.[0] || '';
      if (jid) {
        if (session === 'default' || session === 'all') {
          queue.closeStdin(jid, DEFAULT_SESSION_NAME);
        }
        if (session === 'maintenance' || session === 'all') {
          queue.closeStdin(jid, MAINTENANCE_SESSION_NAME);
        }
      }
      // Clear stored sessionIds for the killed slot(s). `deleteSession`
      // removes every row for the folder — reuse for 'all'. For
      // single-slot nukes we use the new `deleteSessionName` helper so
      // the surviving slot keeps its session chain.
      if (session === 'all') {
        delete sessions[groupFolder];
        deleteSession(groupFolder);
      } else {
        const sessionName =
          session === 'default'
            ? DEFAULT_SESSION_NAME
            : MAINTENANCE_SESSION_NAME;
        if (sessions[groupFolder]) delete sessions[groupFolder][sessionName];
        deleteSessionName(groupFolder, sessionName);
      }

      // Step 4: wipe on-disk session artifacts (JSONL transcript +
      // per-session tool-results directory). Delete-while-open is
      // safe on POSIX (the container's open FD keeps writing to a
      // phantom inode that vanishes on close), so we don't have to wait
      // for closeStdin to actually terminate the process. The returned
      // `count` is the total number of filesystem entries removed: up
      // to 2 per slug (1 transcript + 1 tool-results dir), summed
      // across every project-slug subdirectory walked.
      for (const [slot, sessionId] of sessionIdsToWipe) {
        const wiped = wipeSessionJsonl(groupFolder, slot, sessionId);
        if (wiped > 0) {
          logger.info(
            { groupFolder, sessionName: slot, sessionId, count: wiped },
            'Wiped session artifacts (transcript + tool-results dir)',
          );
        }
      }

      logger.info({ groupFolder, session }, 'Session nuked via IPC');
    },
    getContainerStatus: (chatJid, sessionName) => {
      // Combine the GroupQueue's per-slot signals (active/idleWaiting/
      // retryCount/lastExitStatus) with the long-term per-folder
      // circuit breaker. The breaker lives here, not in GroupQueue,
      // because it's keyed on group.folder and is set by message-loop
      // bookkeeping rather than queue lifecycle. Both signals are
      // cooldown windows from the chat_status caller's perspective.
      const group = registeredGroups[chatJid];
      const breakerExpiry = group ? circuitBreakerUntil[group.folder] : 0;
      const breakerActive = !!breakerExpiry && Date.now() < breakerExpiry;
      return queue.getStatus(chatJid, sessionName, breakerActive);
    },
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(
          group.folder,
          group.isMain === true,
          taskRows,
          !!group.containerConfig?.trusted,
        );
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Per-container streaming logs grow with every spawn. Without
  // pruning, `data/host-logs/containers/<group>/<session>/*.log`
  // would accumulate indefinitely — a chatty trusted group spawning
  // many times a day fills the disk over a few months. Run prune at
  // startup AND once a day thereafter; both are safe and cheap.
  // Retention window is owned by host-logs.ts (currently 7 days).
  void (async () => {
    try {
      const deleted = pruneOldContainerLogs();
      if (deleted > 0) {
        logger.info(
          { deleted },
          'host-logs prune at startup removed expired per-spawn logs',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'host-logs prune at startup failed');
    }
  })();
  // 24h interval, unref'd so the timer doesn't keep the orchestrator
  // alive past graceful shutdown. setInterval is fine even though the
  // logical schedule is "once per day" — the orchestrator process
  // typically lives for weeks, and crash recovery brings the timer
  // back on next start.
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    try {
      const deleted = pruneOldContainerLogs();
      if (deleted > 0) {
        logger.info(
          { deleted },
          'host-logs daily prune removed expired per-spawn logs',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'host-logs daily prune failed');
    }
  }, ONE_DAY_MS).unref();

  // Write available_groups.json for all main/trusted groups on startup.
  // Otherwise the snapshot only updates when a container spawns, which can
  // leave it weeks stale if the group doesn't get traffic.
  const startupGroups = getAvailableGroups();
  const startupRegisteredJids = new Set(Object.keys(registeredGroups));
  for (const [, group] of Object.entries(registeredGroups)) {
    if (group.isMain || group.containerConfig?.trusted) {
      writeGroupsSnapshot(
        group.folder,
        group.isMain === true,
        startupGroups,
        startupRegisteredJids,
        !!group.containerConfig?.trusted,
      );
    }
  }

  // Periodic tile update from registry (every 15 min)
  // Heartbeat runs in the container and can't call tessl update.
  // This catches publishes that the post-promote timer missed.
  const { execFile: execTesslUpdate } = await import('child_process');
  setInterval(() => {
    execTesslUpdate(
      'bash',
      [
        '-c',
        'cd /app/tessl-workspace && tessl update --yes --dangerously-ignore-security --agent claude-code 2>&1',
      ],
      { timeout: 120_000 },
      (err, stdout) => {
        if (err) {
          logger.warn({ error: err.message }, 'Periodic tessl update failed');
        } else if (stdout.includes('Updated')) {
          const cleared = deleteAllSessions();
          logger.info(
            { sessionsCleared: cleared, output: stdout.trim().slice(-200) },
            'Periodic tessl update found new tiles — sessions cleared',
          );
        }
      },
    );
  }, 900_000);

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
