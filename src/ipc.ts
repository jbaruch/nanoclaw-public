import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { sendPoolMessage } from './channels/telegram.js';
import {
  AvailableGroup,
  DEFAULT_SESSION_NAME,
  sessionInputDirName,
} from './container-runner.js';
import { MAINTENANCE_SESSION_NAME } from './group-queue.js';
import {
  createTask,
  deleteAllSessions,
  deleteTask,
  getLastFromMeMessages,
  getTaskById,
  getTasksForGroup,
  storeMessage,
  updateTask,
} from './db.js';
import type { ContainerStatus } from './group-queue.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { stripInternalTags } from './router.js';
import { isValidTimezone } from './timezone.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendReaction?: (
    jid: string,
    messageId: string | undefined,
    emoji: string,
  ) => Promise<void>;
  sendMessage: (
    jid: string,
    text: string,
    replyToMessageId?: string,
  ) => Promise<string | void>;
  pinMessage?: (jid: string, messageId: string) => Promise<void>;
  sendFile?: (
    jid: string,
    filePath: string,
    caption?: string,
    replyToMessageId?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  /**
   * Inverse of `registerGroup` (#159). Removes the in-memory entry and
   * the DB row in one call. Returns false if the JID was not registered
   * — caller can use that to log a no-op or to surface "nothing to do"
   * to the requester. The caller is responsible for refreshing the
   * `available_groups.json` snapshot afterward (mirrors the
   * registerGroup contract).
   *
   * Out of scope: deleting the on-disk `groups/<folder>/` directory.
   * Operators delete that manually; auto-deletion would silently destroy
   * agent-curated state (CLAUDE.md, MEMORY.md, scheduled-task workspace)
   * on every churn of the registration.
   */
  unregisterGroup: (jid: string) => boolean;
  /** Partial update: flip `containerConfig.trusted` only. Returns false if the JID isn't registered. */
  setGroupTrusted: (jid: string, trusted: boolean) => boolean;
  /**
   * Partial update: change the trigger pattern (and optionally
   * `requiresTrigger`) only. Returns false if (a) the JID isn't
   * registered, or (b) the trigger fails the non-empty/whitespace
   * invariant enforced by `updateGroupTrigger`.
   */
  setGroupTrigger: (
    jid: string,
    trigger: string,
    requiresTrigger?: boolean,
  ) => boolean;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
    isTrusted?: boolean,
  ) => void;
  onTasksChanged: () => void;
  nukeSession: (
    groupFolder: string,
    session: 'default' | 'maintenance' | 'all',
  ) => void;
  /**
   * Read the derived container status for a given (jid, sessionName)
   * slot. Used by `chat_status` to surface running/idle/cooling-down/
   * crashed/not-spawned without exposing the queue's internal state map.
   * Implementations must combine the GroupQueue slot state with the
   * orchestrator-side circuit breaker (per group folder).
   */
  getContainerStatus?: (
    chatJid: string,
    sessionName: 'default' | 'maintenance',
  ) => ContainerStatus;
}

let ipcWatcherRunning = false;

/**
 * Path to the `_script_result_<requestId>.json` reply file the host writes
 * for an IPC request. Must land in the SAME session's input dir that the
 * requesting container mounts at `/workspace/ipc/input/` — otherwise the
 * container polls forever and the IPC call times out.
 *
 * The container-side MCP server stamps `sessionName` onto every IPC
 * payload (both TASKS and MESSAGES — see
 * `container/agent-runner/src/ipc-mcp-stdio.ts`). Older containers that
 * predate that change (or any request where the field is missing) fall
 * back to the default session — matches pre-parallel behavior where
 * only one session existed.
 */
// Session names accepted on IPC requests: ONLY the two the orchestrator
// ever creates. A broader regex (e.g. `[A-Za-z0-9_-]+`) would let a
// container send distinct valid-looking names and force the host into
// unbounded `input-<session>/` dir creation below — an empty-dir DoS.
// Canonical enum is the right level of trust for payload-supplied values.
const KNOWN_SESSION_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_SESSION_NAME,
  MAINTENANCE_SESSION_NAME,
]);
const VALID_REQUEST_ID_RE = /^[A-Za-z0-9_-]+$/;

// Host-side allowlist for the five tile-repo names the promote flow is
// wired against. The MCP tools' zod enums (ipc-mcp-stdio.ts::TILE_NAMES)
// mirror this list client-side for a clean schema error at tool-call
// time, but the IPC handler is reachable by any payload dropped into
// the tasks dir — a compromised container could skip the MCP path and
// write `{tileName: "../../etc"}` directly, escaping GROUPS_DIR via
// `path.join` or pointing the bash scripts at an attacker-controlled
// git URL. This set is the actual trust boundary; keeping it in sync
// with the client-side enum is a release-hygiene concern.
const KNOWN_TILE_NAMES: ReadonlySet<string> = new Set([
  'nanoclaw-admin',
  'nanoclaw-core',
  'nanoclaw-untrusted',
  'nanoclaw-trusted',
  'nanoclaw-host',
]);

/**
 * Compute the host path where an IPC response file should land.
 *
 * Both `data.sessionName` and `data.requestId` arrive from the container's
 * IPC payload — treat as untrusted. Without validation, crafted values
 * like `../default` or `../../etc/passwd` would make `path.join` escape
 * the expected `<DATA_DIR>/ipc/<sourceGroup>/input-<session>/` subtree.
 *
 * Fail-safe strategy, two independent fallbacks:
 * - Invalid `requestId` → fixed filename `_script_result_invalid.json`.
 *   Keeps path traversal out of the filename AND prevents a noisy/
 *   malicious container from filling disk by spamming unique ids —
 *   at most one orphan file per session's input dir, overwritten in
 *   place each time. The SESSION dir is still whatever was validated
 *   from the payload (the `sessionName` check is separate).
 * - Invalid `sessionName` → fall back to `DEFAULT_SESSION_NAME`. Blocks
 *   `..`-style path-segment escape into a different group's subtree.
 *
 * Both fallbacks log at warn level for auditing. The malformed request
 * effectively times out (its response lands where no container polls),
 * which is the correct outcome for a bad payload. This keeps every
 * caller's `fs.writeFileSync(resultPath, ...)` pattern intact (no null-
 * checking at 10+ call sites) while still blocking path traversal.
 */
function scriptResultPath(
  sourceGroup: string,
  data: { sessionName?: string; requestId?: string },
): string {
  let requestId: string;
  if (
    typeof data.requestId === 'string' &&
    VALID_REQUEST_ID_RE.test(data.requestId)
  ) {
    requestId = data.requestId;
  } else {
    logger.warn(
      { sourceGroup, requestId: data.requestId },
      'IPC request has missing or invalid requestId — routing response to orphan path',
    );
    // Fixed filename for all invalid requests so a noisy/malicious container
    // can't spam unique requestIds and fill disk with orphan replies. At
    // most one `_script_result_invalid.json` file exists per input dir, and
    // it gets overwritten on every subsequent malformed request.
    requestId = 'invalid';
  }
  let session = DEFAULT_SESSION_NAME;
  if (typeof data.sessionName === 'string' && data.sessionName) {
    if (KNOWN_SESSION_NAMES.has(data.sessionName)) {
      session = data.sessionName;
    } else {
      logger.warn(
        { sourceGroup, sessionName: data.sessionName },
        'IPC request has unknown sessionName — falling back to default',
      );
    }
  }
  const inputDir = path.join(
    DATA_DIR,
    'ipc',
    sourceGroup,
    sessionInputDirName(session),
  );
  // Ensure the session's input dir exists before the caller writes into it.
  // In the common path both sessions have already spawned at least once and
  // the dir exists — but a maintenance-only group (or a container that has
  // never gone through default) won't have `input-default/`, and our
  // fallback routes here for malformed payloads. Creating the dir
  // defensively keeps `fs.writeFileSync(resultPath, ...)` from throwing
  // ENOENT at every caller.
  fs.mkdirSync(inputDir, { recursive: true });
  return path.join(inputDir, `_script_result_${requestId}.json`);
}

// Prefix for outbound text emitted by the maintenance-session Andy.
// Without the prefix, a scheduled-task reply looks identical to a
// user-facing reply in the chat, which confused Baruch when he
// responded to `[check-unanswered heartbeat from maintenance]` messages
// as if they were live conversation. The prefix is applied BOTH to
// Telegram-bound text AND to the messages.db copy so the full trail
// shows provenance — heartbeat accounting, future message recap, etc.
const MAINTENANCE_MESSAGE_PREFIX = '[M] ';

/**
 * Prepend `[M] ` if the payload came from the maintenance session.
 * Idempotent — if the text already begins with the prefix (double-
 * hop case, agent that hand-typed it, whatever), we don't stack.
 * Exported for the unit test; the production caller is in the same
 * file so the public API is a single entry point.
 *
 * @internal — test-only export, should not be part of the public
 * `.d.ts` surface (we build with `stripInternal: true`).
 */
export function applyMaintenancePrefix(
  text: string,
  sessionName: string | undefined,
): string {
  if (sessionName !== MAINTENANCE_SESSION_NAME) return text;
  if (text.startsWith(MAINTENANCE_MESSAGE_PREFIX)) return text;
  return MAINTENANCE_MESSAGE_PREFIX + text;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            // Hoisted so the catch-block at the bottom can log which
            // message we were processing when things exploded. Without
            // this, a throw after `data = JSON.parse(...)` but before
            // the per-type branches would leave the error-log blind to
            // what content was in flight.
            let data:
              | {
                  type?: string;
                  chatJid?: string;
                  text?: string;
                  sender?: string;
                  replyToMessageId?: string;
                  pin?: boolean;
                  emoji?: string;
                  messageId?: string;
                  filePath?: string;
                  caption?: string;
                  [key: string]: unknown;
                }
              | undefined;
            try {
              const stat = fs.statSync(filePath);
              if (stat.size > 1_048_576) {
                logger.warn(
                  { file, sourceGroup, size: stat.size },
                  'IPC file exceeds 1MB limit, moving to errors',
                );
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
                continue;
              }
              data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (!data) {
                // JSON.parse produced null/undefined (e.g. the file
                // contained literal `null`). Skip to the next file.
                logger.warn(
                  { file, sourceGroup },
                  '[ipc] IPC file parsed to null/undefined — skipping',
                );
                fs.unlinkSync(filePath);
                continue;
              }
              if (
                data.type === 'react_to_message' &&
                data.chatJid &&
                data.emoji &&
                deps.sendReaction
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendReaction(
                    data.chatJid,
                    data.messageId || undefined,
                    data.emoji,
                  );
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      emoji: data.emoji,
                      sourceGroup,
                    },
                    'IPC reaction sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC reaction attempt blocked',
                  );
                }
              } else if (
                data.type === 'send_file' &&
                data.chatJid &&
                data.filePath &&
                deps.sendFile
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Translate container path to host path
                  const containerPath: string = data.filePath;
                  let hostPath: string;
                  if (containerPath.startsWith('/workspace/group/')) {
                    hostPath = path.join(
                      GROUPS_DIR,
                      sourceGroup,
                      containerPath.replace('/workspace/group/', ''),
                    );
                  } else if (containerPath.startsWith('/workspace/trusted/')) {
                    hostPath = path.join(
                      process.cwd(),
                      'trusted',
                      containerPath.replace('/workspace/trusted/', ''),
                    );
                  } else {
                    logger.warn(
                      { containerPath, sourceGroup },
                      'send_file: path outside allowed mounts',
                    );
                    fs.unlinkSync(filePath);
                    continue;
                  }

                  if (fs.existsSync(hostPath)) {
                    // Strip <internal>…</internal> blocks from the caption
                    // so agent-written internal reasoning never leaks —
                    // neither to Telegram (display) nor to messages.db
                    // (which feeds heartbeat's answered-check accounting).
                    // Mirrors the message-payload stripping below. If the
                    // caption is fully internal, send the file with no
                    // caption; the file itself is still useful payload.
                    const strippedCaption = data.caption
                      ? stripInternalTags(data.caption)
                      : '';
                    // Tag maintenance-session captions so Baruch can
                    // tell a scheduled-task file-send from a live one.
                    // Skip the prefix entirely when the caption is
                    // empty — `[M] ` alone on a silent file-send is
                    // noise.
                    const cleanCaption = strippedCaption
                      ? applyMaintenancePrefix(
                          strippedCaption,
                          typeof data.sessionName === 'string'
                            ? data.sessionName
                            : undefined,
                        )
                      : '';
                    await deps.sendFile(
                      data.chatJid,
                      hostPath,
                      cleanCaption || undefined,
                      data.replyToMessageId,
                    );
                    // Store the cleaned caption (if any) so the message
                    // shows up in accounting the same as text messages.
                    // Without this, `send_file` is a bypass: captions
                    // reach Telegram but never hit messages.db, so
                    // heartbeat unanswered-checks think the agent never
                    // responded. Store the cleaned version — storing the
                    // raw caption would let a caption whose visible text
                    // was empty after stripping count as an "answered"
                    // response.
                    if (cleanCaption) {
                      storeMessage({
                        id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                        chat_jid: data.chatJid,
                        sender: ASSISTANT_NAME,
                        sender_name: ASSISTANT_NAME,
                        content: cleanCaption,
                        timestamp: new Date().toISOString(),
                        is_from_me: true,
                        is_bot_message: true,
                        reply_to_message_id: data.replyToMessageId,
                      });
                    }
                    logger.info(
                      { chatJid: data.chatJid, hostPath, sourceGroup },
                      'IPC file sent',
                    );
                  } else {
                    logger.warn(
                      { hostPath, containerPath, sourceGroup },
                      'send_file: file not found on host',
                    );
                  }
                }
              } else if (data.type === 'message' && data.chatJid && data.text) {
                logger.debug(
                  {
                    sourceGroup,
                    chatJid: data.chatJid,
                    rawTextLen: data.text.length,
                    rawPreview: String(data.text).slice(0, 80),
                    hasSender: Boolean(data.sender),
                    senderValue: data.sender,
                    hasReplyTo: Boolean(data.replyToMessageId),
                    hasPin: Boolean(data.pin),
                    ipcFile: file,
                  },
                  '[ipc] Received send_message IPC',
                );
                // Strip <internal> tags via the shared helper so this
                // path can't drift from the send_file caption path
                // above. If nothing remains, skip silently.
                const strippedText = stripInternalTags(data.text);
                if (!strippedText) {
                  logger.debug(
                    { sourceGroup },
                    '[ipc] send_message suppressed (all internal)',
                  );
                  fs.unlinkSync(filePath);
                  continue;
                }
                // Tag maintenance-session text so Baruch can tell a
                // scheduled-task reply from a live conversational one.
                // Applied AFTER internal-tag stripping (no point
                // prefixing text we're about to suppress) and BEFORE
                // both the Telegram send and the messages.db store, so
                // the prefix flows through accounting uniformly.
                const cleanText = applyMaintenancePrefix(
                  strippedText,
                  typeof data.sessionName === 'string'
                    ? data.sessionName
                    : undefined,
                );
                logger.debug(
                  {
                    sourceGroup,
                    chatJid: data.chatJid,
                    cleanLen: cleanText.length,
                    cleanPreview: cleanText.slice(0, 80),
                  },
                  '[ipc] send_message after stripInternalTags + maintenance-prefix',
                );

                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                const authOk =
                  isMain ||
                  Boolean(targetGroup && targetGroup.folder === sourceGroup);
                logger.debug(
                  {
                    sourceGroup,
                    chatJid: data.chatJid,
                    isMain,
                    targetGroupFolder: targetGroup?.folder,
                    authOk,
                  },
                  '[ipc] send_message auth check',
                );
                if (authOk) {
                  const usePool = Boolean(
                    data.sender && data.chatJid.startsWith('tg:'),
                  );
                  logger.debug(
                    {
                      sourceGroup,
                      chatJid: data.chatJid,
                      path: usePool ? 'pool' : 'direct',
                      sender: data.sender,
                    },
                    '[ipc] send_message path decision',
                  );
                  // Capture whichever send path's message ID applies. Both
                  // `sendPoolMessage` and `deps.sendMessage` return the
                  // Telegram-native message ID (or undefined if the send
                  // failed or the channel isn't Telegram). Stored on the
                  // messages row so "which bot send produced Telegram ID X"
                  // is queryable without log spelunking.
                  // Normalize immediately: both send paths can return
                  // `string | void | undefined`. Collapsing to the
                  // `string | undefined` domain up front keeps downstream
                  // uses (`pinMessage`, `storeMessage`) type-safe without
                  // truthiness checks that would also drop legitimate
                  // empty-string / '0' IDs if Telegram ever returns them.
                  let sentMsgId: string | undefined;
                  if (usePool) {
                    // `usePool` is only true when `data.sender` is a non-
                    // empty string — TS just can't re-narrow across the
                    // intermediate `Boolean(...)` boundary. The `!` is
                    // safe by the `usePool` definition directly above.
                    const poolResult = await sendPoolMessage(
                      data.chatJid,
                      cleanText,
                      data.sender!,
                      sourceGroup,
                    );
                    sentMsgId =
                      typeof poolResult === 'string' ? poolResult : undefined;
                    logger.debug(
                      {
                        sourceGroup,
                        chatJid: data.chatJid,
                        sentMsgId,
                      },
                      '[ipc] sendPoolMessage returned',
                    );
                  } else {
                    const directResult = await deps.sendMessage(
                      data.chatJid,
                      cleanText,
                      data.replyToMessageId,
                    );
                    sentMsgId =
                      typeof directResult === 'string'
                        ? directResult
                        : undefined;
                    logger.debug(
                      {
                        sourceGroup,
                        chatJid: data.chatJid,
                        sentMsgId,
                      },
                      '[ipc] deps.sendMessage returned',
                    );
                    // Pin the message if requested
                    if (data.pin && sentMsgId && deps.pinMessage) {
                      await deps.pinMessage(data.chatJid, sentMsgId);
                      logger.debug(
                        { sourceGroup, chatJid: data.chatJid, sentMsgId },
                        '[ipc] pinMessage returned',
                      );
                    }
                  }
                  // Store bot response so heartbeat can track answered messages.
                  // If we reach here the send path (pool or direct) returned
                  // without an unhandled throw — so a DB row should ALWAYS
                  // appear unless the storeMessage call itself throws (see
                  // outer catch).
                  const botRowId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                  storeMessage({
                    id: botRowId,
                    chat_jid: data.chatJid,
                    sender: data.sender || ASSISTANT_NAME,
                    sender_name: data.sender || ASSISTANT_NAME,
                    content: cleanText,
                    timestamp: new Date().toISOString(),
                    is_from_me: true,
                    is_bot_message: true,
                    reply_to_message_id: data.replyToMessageId,
                    telegram_message_id: sentMsgId,
                  });
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      botRowId,
                      contentLen: cleanText.length,
                    },
                    '[ipc] send_message complete — DB row written',
                  );
                } else {
                  logger.warn(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      targetGroupFolder: targetGroup?.folder,
                    },
                    '[ipc] Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              // Catches anything thrown above (JSON.parse, auth, send, storeMessage).
              // If this fires AFTER the send already landed in Telegram, the
              // user sees a message with no DB row — exactly the ghost-heartbeat
              // symptom. Log the err, the data type, and a preview so the
              // operator can correlate with what appeared in the chat.
              logger.error(
                {
                  file,
                  sourceGroup,
                  err,
                  dataType: (data as { type?: string } | undefined)?.type,
                  dataChatJid: (data as { chatJid?: string } | undefined)
                    ?.chatJid,
                  dataTextPreview:
                    typeof (data as { text?: string } | undefined)?.text ===
                    'string'
                      ? (data as { text: string }).text.slice(0, 200)
                      : undefined,
                },
                '[ipc] Error processing IPC message — message may have been sent to the chat before the throw, in which case no DB row will exist',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const stat = fs.statSync(filePath);
              if (stat.size > 1_048_576) {
                logger.warn(
                  { file, sourceGroup, size: stat.size },
                  'IPC task file exceeds 1MB limit, moving to errors',
                );
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
                continue;
              }
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    /**
     * IANA timezone for cron expressions; #102.
     *
     * `null` is also accepted on the update path (where it means
     * "clear back to TIMEZONE default"). Must be `string | null` — not
     * just `string` — because IPC payloads arrive as raw JSON and the
     * caller can legitimately send `null` to unset; TS strict mode
     * would otherwise reject the `data.timezone === null` check.
     */
    timezone?: string | null;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For set_trusted
    trusted?: boolean;
    // For host operations / github_backup / promote_staging
    requestId?: string;
    message?: string;
    tileName?: string;
    skillName?: string;
    // push_staged_to_branch
    branch?: string;
    commitMessage?: string;
    slug?: string;
    filter?: Record<string, boolean>;
    dryRun?: boolean;
    command?: string;
    payload?: string | Record<string, unknown>;
    confirm?: boolean;
    // chat_status / nuke_chat
    chat_id?: string;
    chat_name?: string;
    session?: 'default' | 'maintenance' | 'all';
    /**
     * Continuation marker for self-resuming cycles (#93/#130). Set by the
     * resumable-cycle helper skill when scheduling the next link of a
     * chain via `schedule_task`. Persisted onto the scheduled_tasks row
     * verbatim; surfaced to the spawned container at fire time as
     * `NANOCLAW_CONTINUATION=1` + `NANOCLAW_CONTINUATION_CYCLE_ID=<value>`.
     * Free-form opaque slot key (UTC date / ISO week per the proposal),
     * but type-narrowed to string for safety; non-string values are
     * dropped at the handler.
     */
    continuation_cycle_id?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        // #102: optional IANA timezone parameter. Validated up-front so
        // a typo fails the schedule call rather than silently falling
        // back to server-local at fire time.
        //
        // Force `null` for non-cron types: the column has no effect on
        // `interval` (always elapsed-ms) or `once` (instant pinned at
        // schedule time). Persisting it for those types would be a
        // footgun if the task were later updated to `cron` without
        // explicitly passing `timezone` — an old, previously-ignored
        // value would silently start affecting cron evaluation.
        let scheduleTimezone: string | null = null;
        if (
          data.timezone !== undefined &&
          data.timezone !== null &&
          data.timezone !== ''
        ) {
          // Order matters here: ignore-because-non-cron BEFORE
          // validate-IANA. A `once` task that happens to carry a
          // typo'd timezone field shouldn't fail to schedule — the
          // field has no effect anyway, just drop it. Validate only
          // when we'd otherwise persist the value.
          if (scheduleType !== 'cron') {
            logger.warn(
              { timezone: data.timezone, scheduleType },
              'schedule_task: timezone parameter is only meaningful for cron — ignoring',
            );
          } else if (!isValidTimezone(data.timezone)) {
            logger.warn(
              { timezone: data.timezone },
              'Invalid IANA timezone for schedule_task',
            );
            break;
          } else {
            scheduleTimezone = data.timezone;
          }
        }

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: scheduleTimezone || TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch (err) {
            // Bind + filter rather than catch-all per
            // `jbaruch/coding-policy: error-handling`. CronExpressionParser
            // throws plain Error instances on invalid syntax; anything
            // non-Error here is a bug somewhere else (e.g. a `throw "str"`
            // upstream) and should propagate.
            if (!(err instanceof Error)) throw err;
            logger.warn(
              { err: err.message, scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const MIN_INTERVAL_MS = 60_000;
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms < MIN_INTERVAL_MS) {
            logger.warn(
              { scheduleValue: data.schedule_value, minMs: MIN_INTERVAL_MS },
              'Invalid interval: must be at least 60s',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        // Provenance: derived from the VERIFIED source group's trust tier
        // (sourceGroup and isMain are set from the IPC directory path, not
        // from untrusted payload fields). The agent that scheduled the
        // task NEVER gets to claim its own role — this is the security
        // boundary that keeps an untrusted group from self-scheduling a
        // prompt that later fires unwrapped as if it were trusted.
        const sourceGroupEntry = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const createdByRole:
          | 'main_agent'
          | 'trusted_agent'
          | 'untrusted_agent' = isMain
          ? 'main_agent'
          : sourceGroupEntry?.containerConfig?.trusted
            ? 'trusted_agent'
            : 'untrusted_agent';
        // Optional continuation marker (#93/#130). Set by the
        // resumable-cycle helper skill when scheduling the next link of a
        // self-resuming cycle chain; the task-scheduler reads it at fire
        // time and plumbs the matching env vars onto the spawned
        // container. Untyped non-string values are dropped — the field is
        // a free-form opaque slot key (per the proposal: UTC date for
        // nightly/morning-brief, ISO week for weekly), but we never want
        // a stray number / object to land in the DB column.
        let continuationCycleId: string | null = null;
        if (
          typeof data.continuation_cycle_id === 'string' &&
          data.continuation_cycle_id.length > 0
        ) {
          continuationCycleId = data.continuation_cycle_id;
        }
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          schedule_timezone: scheduleTimezone,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
          created_by_role: createdByRole,
          continuation_cycle_id: continuationCycleId,
        });
        logger.info(
          {
            taskId,
            sourceGroup,
            targetFolder,
            contextMode,
            createdByRole,
            continuationCycleId,
          },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // #102: optional timezone update. `null`/empty-string clears
        // (back to TIMEZONE default); a non-null IANA string overrides.
        // Only meaningful for cron tasks: if the task IS a cron (or is
        // being changed to cron in this same update), accept and
        // persist; otherwise force the value to null so we don't store
        // a stray timezone that would silently start affecting cron
        // evaluation if the task were later switched to cron without
        // explicitly re-passing it.
        const effectiveScheduleType =
          updates.schedule_type ?? task.schedule_type;

        // If the schedule_type is being changed AWAY from cron AND the
        // existing row had a stored schedule_timezone, drop the stored
        // value too — even if the caller didn't explicitly pass
        // `timezone`. Otherwise a once/interval task can outlive a
        // previous cron incarnation with a stray timezone column that
        // would re-activate if the task were later flipped back to
        // cron without re-stating tz. (Copilot review round 2.)
        if (
          updates.schedule_type !== undefined &&
          updates.schedule_type !== 'cron' &&
          task.schedule_timezone &&
          data.timezone === undefined
        ) {
          updates.schedule_timezone = null;
        }

        if (data.timezone !== undefined) {
          if (data.timezone === '' || data.timezone === null) {
            updates.schedule_timezone = null;
          } else if (effectiveScheduleType !== 'cron') {
            // Check non-cron BEFORE validating IANA: a typo'd tz on a
            // once/interval task should drop silently, not abort the
            // whole update — the field has no effect anyway.
            logger.warn(
              {
                taskId: data.taskId,
                timezone: data.timezone,
                effectiveScheduleType,
              },
              'update_task: ignoring timezone — effective schedule_type is not cron',
            );
            updates.schedule_timezone = null;
          } else if (!isValidTimezone(data.timezone)) {
            logger.warn(
              { taskId: data.taskId, timezone: data.timezone },
              'Invalid IANA timezone in task update',
            );
            break;
          } else {
            updates.schedule_timezone = data.timezone;
          }
        }

        // Recompute next_run if a recompute-relevant field changed.
        // Use `!== undefined` (not truthiness) for `schedule_value`
        // because an empty string IS a valid input on the wire (the
        // host catches it below as invalid) — truthy-skip would
        // silently leave next_run stale on a malformed update. For
        // `timezone`, only count it as a recompute trigger when the
        // (effective) schedule_type is cron — a timezone-only update
        // on a once/interval task has no effect on next_run.
        const triggerRecompute =
          data.schedule_type !== undefined ||
          data.schedule_value !== undefined ||
          (data.timezone !== undefined && effectiveScheduleType === 'cron');
        if (triggerRecompute) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: updatedTask.schedule_timezone || TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch (err) {
              // See schedule_task above — same Error-or-rethrow pattern
              // per `jbaruch/coding-policy: error-handling`.
              if (!(err instanceof Error)) throw err;
              logger.warn(
                {
                  err: err.message,
                  taskId: data.taskId,
                  value: updatedTask.schedule_value,
                },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const MIN_INTERVAL_MS = 60_000;
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms >= MIN_INTERVAL_MS) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            } else if (!isNaN(ms)) {
              logger.warn(
                {
                  taskId: data.taskId,
                  value: updatedTask.schedule_value,
                  minMs: MIN_INTERVAL_MS,
                },
                'Invalid interval in task update: must be at least 60s',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'once') {
            // #102 follow-up: if a once-task's schedule_value changes
            // (or the type flips to 'once'), recompute next_run from
            // the new timestamp. Without this branch the row would
            // keep its old `next_run` and fire incorrectly.
            const date = new Date(updatedTask.schedule_value);
            if (isNaN(date.getTime())) {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid once timestamp in task update',
              );
              break;
            }
            updates.next_run = date.toISOString();
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (
        typeof data.jid === 'string' &&
        typeof data.name === 'string' &&
        typeof data.folder === 'string' &&
        typeof data.trigger === 'string' &&
        data.jid.length > 0 &&
        data.name.length > 0 &&
        data.folder.length > 0 &&
        data.trigger.length > 0
      ) {
        // `typeof === 'string'` guards BEFORE calling `.trim()` on
        // any field. IPC payloads are untrusted JSON: a malformed
        // request like `{jid: {}}` or `{name: 42}` would otherwise
        // throw a TypeError and route the task file to ipc/errors,
        // creating a low-effort log-spam / DoS vector. set_trusted /
        // set_trigger already follow this pattern; this reuses it.
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Trim string fields so this IPC path can't leave a group
        // registered under a whitespace-padded key. set_trusted /
        // set_trigger trim before lookup; an untrimmed register would
        // otherwise produce a "ghost" registration the partial-update
        // tools can never match. Same normalization, same site of
        // truth.
        const trimmedJid = data.jid.trim();
        const trimmedName = data.name.trim();
        const trimmedTrigger = data.trigger.trim();
        if (
          trimmedJid.length === 0 ||
          trimmedName.length === 0 ||
          trimmedTrigger.length === 0
        ) {
          logger.warn(
            { data },
            'Invalid register_group request - empty/whitespace fields',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[trimmedJid];
        deps.registerGroup(trimmedJid, {
          name: trimmedName,
          folder: data.folder,
          trigger: trimmedTrigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          // Explicitly default to `false` when caller omits — matches
          // the MCP tool's documented default ("respond to all
          // messages"). setRegisteredGroup now preserves undefined as
          // SQL NULL, which is a distinct state from `false`, so we
          // must not pass undefined here or the new row would behave
          // differently than callers expect.
          requiresTrigger: data.requiresTrigger ?? false,
          isMain: existingGroup?.isMain,
        });
        // Refresh snapshot so available_groups.json reflects new trust config immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'unregister_group': {
      // Inverse of register_group (#159). Same isMain gate — only the
      // main group can change the registry. The dormant-row problem
      // (#159 motivation) is exactly what happens when there is no
      // structured remove path: rows linger forever, the spawner
      // ignores them because the JSON snapshot doesn't list them, and
      // operators can't fix it from inside chat containers because
      // `/workspace/store/messages.db` is mounted read-only there.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized unregister_group attempt blocked',
        );
        break;
      }
      if (typeof data.jid !== 'string' || data.jid.trim().length === 0) {
        logger.warn(
          { data },
          'Invalid unregister_group request - missing/empty jid',
        );
        break;
      }
      const trimmedJid = data.jid.trim();
      const target = registeredGroups[trimmedJid];
      if (!target) {
        logger.warn(
          { jid: trimmedJid },
          'unregister_group: group not registered (no-op)',
        );
        break;
      }
      // Refuse to unregister a main group via IPC. Losing the main
      // registration mid-runtime would leave the orchestrator without
      // any path that can re-create it (the same isMain gate above
      // would reject the corresponding register_group call). The
      // operator can flip `is_main` directly in the DB if they really
      // mean to, which is a deliberate destructive action rather than
      // a one-line MCP call.
      if (target.isMain) {
        logger.warn(
          { jid: trimmedJid, folder: target.folder },
          'unregister_group: refusing to unregister main group',
        );
        break;
      }
      // Cascade-delete scheduled_tasks tied to the unregistered folder
      // BEFORE we drop the registration. Without this, the scheduler
      // keeps firing the auto-created heartbeat (and any other tasks
      // bound to this folder) every cycle, logging "Group not found
      // for task" on each tick — exactly the noisy-orphan behaviour
      // Copilot flagged on PR #198. We do this before unregisterGroup
      // so a crash between the two leaves the registration alive (DB
      // delete is the authoritative atomic step); the inverse ordering
      // would orphan the registration with its tasks already gone,
      // which is the more confusing recovery path.
      const orphanTasks = getTasksForGroup(target.folder);
      for (const task of orphanTasks) {
        deleteTask(task.id);
      }
      if (orphanTasks.length > 0) {
        logger.info(
          {
            jid: trimmedJid,
            folder: target.folder,
            taskIds: orphanTasks.map((t) => t.id),
          },
          'unregister_group: cascade-deleted scheduled tasks for unregistered folder',
        );
        deps.onTasksChanged();
      }

      const removed = deps.unregisterGroup(trimmedJid);
      if (!removed) {
        // In-memory said yes but DB said no — possible if a parallel
        // path raced us. Log and fall through to snapshot refresh
        // anyway: the snapshot is derived state and a refresh is
        // always safe.
        logger.warn(
          { jid: trimmedJid, folder: target.folder },
          'unregister_group: in-memory entry present but DB delete reported no rows',
        );
      } else {
        logger.info(
          { jid: trimmedJid, folder: target.folder },
          'Group unregistered',
        );
      }
      // Refresh snapshot so available_groups.json no longer flags the
      // removed JID as registered. Same site-of-truth pattern as
      // register_group / set_trusted / set_trigger above.
      const availableGroups = deps.getAvailableGroups();
      deps.writeGroupsSnapshot(
        sourceGroup,
        true,
        availableGroups,
        new Set(Object.keys(registeredGroups)),
      );
      break;
    }

    case 'set_trusted':
      // Partial update: flip container_config.trusted only. Same isMain
      // gate as register_group — only the main group can change trust
      // state. See #105.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized set_trusted attempt blocked',
        );
        break;
      }
      if (
        typeof data.jid === 'string' &&
        data.jid.trim().length > 0 &&
        typeof data.trusted === 'boolean'
      ) {
        // Trim JID for the same reason as set_trigger: avoids a
        // misleading "group not registered" warning when a caller
        // passes whitespace-padded JID.
        const trimmedJid = data.jid.trim();
        const ok = deps.setGroupTrusted(trimmedJid, data.trusted);
        if (!ok) {
          logger.warn(
            { jid: trimmedJid },
            'set_trusted: group not registered (use register_group first)',
          );
          break;
        }
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
        // setGroupTrusted may have reconciled the heartbeat task's
        // `script` field as a side effect of the trust flip — refresh
        // the per-group task snapshots so containers see the change
        // on their next read instead of waiting for the orchestrator
        // to write a snapshot for some other reason.
        deps.onTasksChanged();
      } else {
        logger.warn(
          { data },
          'Invalid set_trusted request - missing/empty jid or invalid trusted',
        );
      }
      break;

    case 'set_trigger':
      // Partial update: change trigger_pattern and optionally
      // requires_trigger. Same isMain gate as register_group. See #105.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized set_trigger attempt blocked',
        );
        break;
      }
      if (
        typeof data.jid === 'string' &&
        data.jid.trim().length > 0 &&
        typeof data.trigger === 'string' &&
        data.trigger.trim().length > 0
      ) {
        // Reject empty/whitespace triggers + JIDs, then pass the
        // trimmed values downstream. `getTriggerPattern('')` trims and
        // falls back to `DEFAULT_TRIGGER`, so an empty trigger would
        // silently revert the group to the assistant's default trigger
        // word — not what the caller asked for. Trimming the JID
        // before lookup avoids a misleading "group not registered"
        // warning when a caller passes `' tg:-123 '` (whitespace would
        // never match the registry key).
        const trimmedJid = data.jid.trim();
        const trimmedTrigger = data.trigger.trim();
        const requiresTrigger =
          typeof data.requiresTrigger === 'boolean'
            ? data.requiresTrigger
            : undefined;
        const ok = deps.setGroupTrigger(
          trimmedJid,
          trimmedTrigger,
          requiresTrigger,
        );
        if (!ok) {
          logger.warn(
            { jid: trimmedJid },
            'set_trigger: group not registered (use register_group first)',
          );
          break;
        }
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { data },
          'Invalid set_trigger request - missing/empty jid or trigger',
        );
      }
      break;

    case 'nuke_session':
      if (data.groupFolder) {
        // Optional `session` arg narrows the nuke to one slot. Accepted
        // values: 'default', 'maintenance', 'all'. Anything else (or
        // missing) falls back to 'all' — the safe default that preserves
        // pre-parallel behaviour. The value comes from the container's
        // IPC payload so we cast from `unknown` and allowlist.
        const sessionArg = (data as Record<string, unknown>).session;
        const validSession: 'default' | 'maintenance' | 'all' =
          sessionArg === 'default' || sessionArg === 'maintenance'
            ? sessionArg
            : 'all';
        // `sourceGroup` is authoritative (derived from the IPC dir the
        // request arrived in); `data.groupFolder` is only used as a
        // "yes-really-nuke" opt-in flag above and its value isn't honoured
        // downstream. Log sourceGroup to avoid misleading audit trails if
        // they ever differ.
        logger.info(
          { sourceGroup, session: validSession },
          'Session nuke requested via IPC',
        );
        deps.nukeSession(sourceGroup, validSession);
      }
      break;

    case 'chat_status': {
      // Admin tile only. Returns a structured snapshot per chat: the
      // host-side state the admin needs to diagnose silent containers
      // (running / idle / cooling-down / crashed / not-spawned), tile
      // classification, trigger config, and the latest is_from_me=1
      // message recorded for the chat.
      const resultPath = scriptResultPath(sourceGroup, data);
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized chat_status attempt blocked',
        );
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            error: 'chat_status is admin-tile only',
          }),
        );
        break;
      }

      // Resolve which chats to report on. Four cases:
      //   - both chat_id AND chat_name → reject. Two identifiers that
      //     might disagree is unsafe targeting; force the caller to
      //     pick one. Defense in depth — the MCP tool layer also
      //     blocks this, but a payload arriving directly via the IPC
      //     dir would otherwise let chat_id silently win.
      //   - chat_id provided → report only that one (must be registered).
      //   - chat_name provided → resolve via name match in
      //     registeredGroups (multiple matches → ambiguous error so the
      //     caller can pick the right JID rather than us guessing).
      //   - neither provided → all registered chats.
      const hasChatId =
        typeof data.chat_id === 'string' && data.chat_id.trim().length > 0;
      const hasChatName =
        typeof data.chat_name === 'string' && data.chat_name.trim().length > 0;
      if (hasChatId && hasChatName) {
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            error:
              'chat_status accepts chat_id OR chat_name, not both — they may disagree',
          }),
        );
        break;
      }
      const targets: string[] = [];
      if (hasChatId) {
        const trimmed = (data.chat_id as string).trim();
        if (!registeredGroups[trimmed]) {
          fs.writeFileSync(
            resultPath,
            JSON.stringify({
              error: `chat_id ${trimmed} not registered`,
            }),
          );
          break;
        }
        targets.push(trimmed);
      } else if (hasChatName) {
        const wanted = (data.chat_name as string).trim();
        const matches = Object.entries(registeredGroups).filter(
          ([, g]) => g.name === wanted,
        );
        if (matches.length === 0) {
          fs.writeFileSync(
            resultPath,
            JSON.stringify({
              error: `chat_name "${wanted}" did not match any registered chat`,
            }),
          );
          break;
        }
        if (matches.length > 1) {
          fs.writeFileSync(
            resultPath,
            JSON.stringify({
              error: `chat_name "${wanted}" is ambiguous — matches ${matches.length} chats`,
              candidates: matches.map(([jid]) => jid),
            }),
          );
          break;
        }
        targets.push(matches[0][0]);
      } else {
        targets.push(...Object.keys(registeredGroups));
      }

      // Batch the "latest is_from_me=1 message per chat" lookup into a
      // single grouped query (idx_messages_fromme_chat composite
      // index). Per-target getLastFromMeMessage calls were N
      // statement compilations + N scan-and-sort passes; this is one
      // query for any N.
      const lastMessages = getLastFromMeMessages(targets);

      const rows = targets.map((jid) => {
        const group = registeredGroups[jid];
        const tile: 'admin' | 'trusted' | 'untrusted' = group.isMain
          ? 'admin'
          : group.containerConfig?.trusted
            ? 'trusted'
            : 'untrusted';
        // requiresTrigger defaults differ per tile: main groups bypass
        // the trigger entirely (privileged inbox), while non-main groups
        // require the trigger unless explicitly opted out. Mirror the
        // canSenderInteract logic so the reported value matches what
        // the orchestrator actually enforces.
        const triggered = group.isMain
          ? false
          : group.requiresTrigger !== false;
        const last = lastMessages.get(jid) ?? null;
        return {
          chat_id: jid,
          chat_name: group.name,
          trigger: triggered ? 'triggered' : 'untriggered',
          tile,
          last_ayeaye_message: last
            ? {
                timestamp: last.timestamp,
                // Truncate to keep the response small even if the
                // agent sent a multi-kilobyte reply. 200 chars matches
                // what fits comfortably in the admin's chat preview.
                content_snippet:
                  last.content.length > 200
                    ? last.content.slice(0, 200) + '…'
                    : last.content,
              }
            : null,
          containers: deps.getContainerStatus
            ? {
                default: deps.getContainerStatus(jid, 'default'),
                maintenance: deps.getContainerStatus(jid, 'maintenance'),
              }
            : { default: 'not-spawned', maintenance: 'not-spawned' },
        };
      });

      logger.info(
        { sourceGroup, count: rows.length },
        'chat_status served via IPC',
      );
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ stdout: JSON.stringify({ chats: rows }) }),
      );
      break;
    }

    case 'nuke_chat': {
      // Admin tile only. Cross-chat nuke — looks up the target by
      // chat_id or chat_name and forwards to the same wipeSessionJsonl
      // path the per-chat nuke_session uses. Hard-fails when neither
      // identifier is provided so admin can never accidentally nuke
      // its own chat by omission (the nuke_session tool already does
      // "this chat" — nuke_chat is only useful when targeting another).
      const resultPath = scriptResultPath(sourceGroup, data);
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized nuke_chat attempt blocked');
        fs.writeFileSync(
          resultPath,
          JSON.stringify({ error: 'nuke_chat is admin-tile only' }),
        );
        break;
      }

      const hasId =
        typeof data.chat_id === 'string' && data.chat_id.trim().length > 0;
      const hasName =
        typeof data.chat_name === 'string' && data.chat_name.trim().length > 0;
      if (!hasId && !hasName) {
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            error:
              'nuke_chat requires chat_id or chat_name — admin always operates cross-chat, never on the implicit current chat',
          }),
        );
        break;
      }
      // Two identifiers are an unsafe-targeting smell — if they
      // disagree, silently picking one is worse than refusing. Reject
      // here too (the MCP tool layer also blocks the same case).
      if (hasId && hasName) {
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            error:
              'nuke_chat accepts chat_id OR chat_name, not both — they may disagree',
          }),
        );
        break;
      }

      let targetJid = '';
      if (hasId) {
        const trimmed = (data.chat_id as string).trim();
        if (!registeredGroups[trimmed]) {
          fs.writeFileSync(
            resultPath,
            JSON.stringify({ error: `chat_id ${trimmed} not registered` }),
          );
          break;
        }
        targetJid = trimmed;
      } else {
        const wanted = (data.chat_name as string).trim();
        const matches = Object.entries(registeredGroups).filter(
          ([, g]) => g.name === wanted,
        );
        if (matches.length === 0) {
          fs.writeFileSync(
            resultPath,
            JSON.stringify({
              error: `chat_name "${wanted}" did not match any registered chat`,
            }),
          );
          break;
        }
        if (matches.length > 1) {
          fs.writeFileSync(
            resultPath,
            JSON.stringify({
              error: `chat_name "${wanted}" is ambiguous — matches ${matches.length} chats`,
              candidates: matches.map(([jid]) => jid),
            }),
          );
          break;
        }
        targetJid = matches[0][0];
      }

      const targetGroup = registeredGroups[targetJid];
      const sessionArg = data.session;
      const validSession: 'default' | 'maintenance' | 'all' =
        sessionArg === 'default' ||
        sessionArg === 'maintenance' ||
        sessionArg === 'all'
          ? sessionArg
          : 'all';

      // Snapshot pre-nuke status to determine which slots actually had
      // a live container to kill. nukeSession ALWAYS wipes JSONL on
      // disk regardless of whether anything was running; the
      // user-visible status enum (per the issue spec) reports the
      // *live-container* outcome so admin can tell whether the call
      // actually freed any resources.
      const slotsRequested: Array<'default' | 'maintenance'> =
        validSession === 'all' ? ['default', 'maintenance'] : [validSession];
      const killedSessions: Array<'default' | 'maintenance'> = [];
      const getStatus = deps.getContainerStatus;
      for (const slot of slotsRequested) {
        const wasActive =
          getStatus &&
          (getStatus(targetJid, slot) === 'running' ||
            getStatus(targetJid, slot) === 'idle');
        if (wasActive) killedSessions.push(slot);
      }

      try {
        deps.nukeSession(targetGroup.folder, validSession);
        // Per the issue's status enum: 'success' when at least one
        // live container was killed; 'noop' when nothing was running
        // (even though the on-disk wipe still happened — see the
        // pre-snapshot comment above). 'partial' is reserved for a
        // future per-slot-failure signal from nukeSession; today
        // nukeSession is fire-and-forget per slot, so we can't
        // distinguish partial failure from full success without a
        // contract change. 'error' is reported only when nukeSession
        // throws — the catch branch below.
        const status: 'success' | 'noop' =
          killedSessions.length > 0 ? 'success' : 'noop';
        logger.info(
          {
            sourceGroup,
            targetJid,
            session: validSession,
            killedSessions,
            status,
          },
          'nuke_chat completed via IPC',
        );
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            stdout: JSON.stringify({
              chat_id: targetJid,
              chat_name: targetGroup.name,
              killed_sessions: killedSessions,
              status,
            }),
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ sourceGroup, targetJid, err }, 'nuke_chat failed');
        // Top-level `error` field — runHostOperation in the
        // agent-runner only treats `result.error` as a tool failure
        // and surfaces `isError: true` to the MCP caller. Burying the
        // failure inside `stdout` would make the call look like a
        // success to Claude, which would then move on as if the wipe
        // ran. Include the structured payload alongside so the admin
        // can still see what was attempted.
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            error: `nuke_chat failed for ${targetJid}: ${msg}`,
            chat_id: targetJid,
            chat_name: targetGroup.name,
            killed_sessions: [],
            status: 'error',
          }),
        );
      }
      break;
    }

    // --- Named host operations ---

    case 'github_backup':
      if (data.requestId) {
        const backupDir = path.join(
          process.cwd(),
          'groups',
          sourceGroup,
          'backup-repo',
        );
        const resultPath = scriptResultPath(sourceGroup, data);

        if (!fs.existsSync(backupDir)) {
          fs.writeFileSync(
            resultPath,
            JSON.stringify({ error: `backup-repo not found at ${backupDir}` }),
          );
          break;
        }

        const commitMsg =
          data.message || `backup: ${new Date().toISOString().split('T')[0]}`;
        logger.info(
          { sourceGroup, backupDir, commitMsg },
          'Running github_backup',
        );

        // Read GitHub token for push auth
        const { readEnvFile: readBackupEnv } = await import('./env.js');
        const backupEnvVars = readBackupEnv(['GITHUB_TOKEN']);
        const ghToken = backupEnvVars.GITHUB_TOKEN;

        execFile(
          'bash',
          [
            '-c',
            `cd "${backupDir}" && git add -A && git diff --cached --quiet && echo '{"stdout":"Nothing to commit."}' || (git commit -m "${commitMsg.replace(/"/g, '\\"')}" && git push && echo '{"stdout":"Committed and pushed."}')`,
          ],
          {
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              ...(ghToken
                ? {
                    GIT_ASKPASS: 'echo',
                    GIT_TERMINAL_PROMPT: '0',
                    GITHUB_TOKEN: ghToken,
                    GIT_CONFIG_COUNT: '1',
                    GIT_CONFIG_KEY_0:
                      'url.https://x-access-token:' +
                      ghToken +
                      '@github.com/.insteadOf',
                    GIT_CONFIG_VALUE_0: 'https://github.com/',
                  }
                : {}),
            },
          },
          (error, stdout, stderr) => {
            if (error) {
              logger.error(
                { sourceGroup, error: error.message, stderr },
                'github_backup failed',
              );
              fs.writeFileSync(
                resultPath,
                JSON.stringify({
                  error: error.message,
                  stderr: stderr.slice(-500),
                }),
              );
            } else {
              // stdout is the JSON echo from the bash script
              try {
                const parsed = JSON.parse(stdout.trim().split('\n').pop()!);
                fs.writeFileSync(resultPath, JSON.stringify(parsed));
              } catch {
                fs.writeFileSync(
                  resultPath,
                  JSON.stringify({ stdout: stdout.trim() }),
                );
              }
              logger.info({ sourceGroup }, 'github_backup completed');
            }
          },
        );
      }
      break;

    case 'promote_staging':
      if (data.requestId && data.tileName && data.skillName) {
        if (!isMain) {
          logger.warn({ sourceGroup }, 'Unauthorized promote_staging attempt');
          break;
        }

        const promoteResultPath = scriptResultPath(sourceGroup, data);

        if (!KNOWN_TILE_NAMES.has(data.tileName)) {
          logger.warn(
            { sourceGroup, tileName: data.tileName },
            'promote_staging rejected: tileName not in allowlist',
          );
          fs.writeFileSync(
            promoteResultPath,
            JSON.stringify({
              error: `Invalid tileName "${data.tileName}". Allowed: ${[...KNOWN_TILE_NAMES].join(', ')}.`,
            }),
          );
          break;
        }

        const promoteScript = path.join(
          process.cwd(),
          'scripts',
          'promote-to-tile-repo.sh',
        );

        if (!fs.existsSync(promoteScript)) {
          fs.writeFileSync(
            promoteResultPath,
            JSON.stringify({
              error: 'promote-to-tile-repo.sh not found',
            }),
          );
          break;
        }

        const stagingDir = path.join(
          GROUPS_DIR,
          sourceGroup,
          'staging',
          data.tileName,
        );

        // Read credentials from .env for tile repo push
        const envPath = path.join(process.cwd(), '.env');
        const envContent = fs.existsSync(envPath)
          ? fs.readFileSync(envPath, 'utf-8')
          : '';
        const getEnv = (key: string) =>
          envContent
            .split('\n')
            .find((l) => l.startsWith(`${key}=`))
            ?.split('=')
            .slice(1)
            .join('=') || '';

        logger.info(
          { sourceGroup, tileName: data.tileName, skillName: data.skillName },
          'Running promote_staging',
        );

        execFile(
          'bash',
          [promoteScript, stagingDir, data.tileName, data.skillName],
          {
            // 15 minutes. promote-to-tile-repo.sh runs `tessl skill
            // review --optimize` on each staged skill, and tessl
            // itself tells you that each review "can take up to 1
            // minute." A bulk promote (`skillName=all`) against a tile
            // with 10+ staged skills easily blows past the old
            // 5-minute cap, which observably killed every bulk promote
            // Andy tried and returned a mid-run truncated error. 15
            // min fits the typical 10-15 skill worst case with
            // headroom; larger bulk promotes should split the staging
            // directory into smaller batches — every skill is reviewed
            // (no per-skill opt-out).
            timeout: 900_000,
            maxBuffer: 5 * 1024 * 1024,
            env: {
              ...process.env,
              GITHUB_TOKEN: getEnv('GITHUB_TOKEN'),
              TILE_OWNER: getEnv('TILE_OWNER') || 'jbaruch',
              ASSISTANT_NAME: getEnv('ASSISTANT_NAME') || 'Andy',
            },
          },
          (error, stdout, stderr) => {
            if (error) {
              logger.error(
                {
                  sourceGroup,
                  error: error.message,
                  stderr: stderr.slice(-500),
                },
                'promote_staging failed',
              );
              fs.writeFileSync(
                promoteResultPath,
                JSON.stringify({
                  error: error.message,
                  stderr: stderr.slice(-500),
                }),
              );
            } else {
              logger.info(
                { sourceGroup },
                'promote_staging opened PR on tile repo',
              );
              fs.writeFileSync(
                promoteResultPath,
                JSON.stringify({ stdout: stdout.trim() }),
              );

              // Post-promote `tessl update` + session clear used to
              // run here on a 5-minute delay, predicated on the old
              // flow that pushed directly to tile main and triggered
              // GHA publish within ~5min. New flow opens a PR and
              // requests Copilot review; publish only happens after
              // the PR is merged (which could be minutes, hours, or
              // never if Copilot/human rejects it). The auto-update
              // would fire against a registry that hasn't changed
              // yet — at best a no-op, at worst tearing down sessions
              // for no reason. The agent now calls the `tessl_update`
              // MCP tool explicitly after the PR merges; a periodic
              // 15-min catch-up in index.ts covers missed invocations.
            }
          },
        );
      }
      break;

    case 'tessl_update':
      if (data.requestId) {
        const tesslResultPath = scriptResultPath(sourceGroup, data);
        if (!isMain) {
          logger.warn({ sourceGroup }, 'Unauthorized tessl_update attempt');
          fs.writeFileSync(
            tesslResultPath,
            JSON.stringify({
              error: 'Only the main group can trigger tessl_update.',
            }),
          );
          break;
        }

        logger.info({ sourceGroup }, 'Running tessl_update');

        execFile(
          'bash',
          [
            '-c',
            'cd /app/tessl-workspace && tessl update --yes --dangerously-ignore-security --agent claude-code 2>&1',
          ],
          { timeout: 150_000, maxBuffer: 2 * 1024 * 1024 },
          (error, stdout) => {
            if (error) {
              logger.error(
                {
                  sourceGroup,
                  error: error.message,
                  output: stdout.slice(-500),
                },
                'tessl_update failed',
              );
              fs.writeFileSync(
                tesslResultPath,
                JSON.stringify({
                  error: error.message,
                  stdout: stdout.slice(-2000),
                }),
              );
              return;
            }
            const output = stdout.trim();
            // `tessl update` prints "Updated ..." when a tile actually
            // moved forward. No-op runs don't, and clearing sessions on a
            // no-op would nuke conversation state for nothing — hence
            // the string check instead of an unconditional clear.
            if (/\bUpdated\b/.test(output)) {
              const cleared = deleteAllSessions();
              logger.info(
                { sourceGroup, sessionsCleared: cleared },
                'tessl_update found new tiles — sessions cleared',
              );
              fs.writeFileSync(
                tesslResultPath,
                JSON.stringify({
                  stdout: `${output}\n\nSessions cleared: ${cleared}`,
                }),
              );
            } else {
              logger.info(
                { sourceGroup },
                'tessl_update completed — no new tiles',
              );
              fs.writeFileSync(
                tesslResultPath,
                JSON.stringify({ stdout: output || '(no output)' }),
              );
            }
          },
        );
      }
      break;

    case 'push_staged_to_branch':
      if (
        data.requestId &&
        data.tileName &&
        data.branch &&
        data.commitMessage
      ) {
        const pushResultPath = scriptResultPath(sourceGroup, data);
        if (!isMain) {
          logger.warn(
            { sourceGroup },
            'Unauthorized push_staged_to_branch attempt',
          );
          fs.writeFileSync(
            pushResultPath,
            JSON.stringify({
              error: 'Only the main group can push to tile branches.',
            }),
          );
          break;
        }

        if (!KNOWN_TILE_NAMES.has(data.tileName)) {
          logger.warn(
            { sourceGroup, tileName: data.tileName },
            'push_staged_to_branch rejected: tileName not in allowlist',
          );
          fs.writeFileSync(
            pushResultPath,
            JSON.stringify({
              error: `Invalid tileName "${data.tileName}". Allowed: ${[...KNOWN_TILE_NAMES].join(', ')}.`,
            }),
          );
          break;
        }

        const pushScript = path.join(
          process.cwd(),
          'scripts',
          'push-staged-to-branch.sh',
        );

        if (!fs.existsSync(pushScript)) {
          fs.writeFileSync(
            pushResultPath,
            JSON.stringify({ error: 'push-staged-to-branch.sh not found' }),
          );
          break;
        }

        const stagingDir = path.join(
          GROUPS_DIR,
          sourceGroup,
          'staging',
          data.tileName,
        );

        // Same .env reader pattern as promote_staging — the orchestrator
        // holds the tile-repo credentials, containers never see them.
        const envPath = path.join(process.cwd(), '.env');
        const envContent = fs.existsSync(envPath)
          ? fs.readFileSync(envPath, 'utf-8')
          : '';
        const getEnv = (key: string) =>
          envContent
            .split('\n')
            .find((l) => l.startsWith(`${key}=`))
            ?.split('=')
            .slice(1)
            .join('=') || '';

        logger.info(
          {
            sourceGroup,
            tileName: data.tileName,
            branch: data.branch,
            skillName: data.skillName || 'all',
          },
          'Running push_staged_to_branch',
        );

        execFile(
          'bash',
          [
            pushScript,
            stagingDir,
            data.tileName,
            data.branch,
            data.commitMessage,
            data.skillName || 'all',
          ],
          {
            // 5 min is enough for a clone-branch + copy + commit +
            // push. No tessl review loop here — fixups don't re-trigger
            // the local optimize pass.
            timeout: 300_000,
            maxBuffer: 2 * 1024 * 1024,
            env: {
              ...process.env,
              GITHUB_TOKEN: getEnv('GITHUB_TOKEN'),
              TILE_OWNER: getEnv('TILE_OWNER') || 'jbaruch',
              ASSISTANT_NAME: getEnv('ASSISTANT_NAME') || 'Andy',
            },
          },
          (error, stdout, stderr) => {
            if (error) {
              logger.error(
                {
                  sourceGroup,
                  error: error.message,
                  stderr: stderr.slice(-500),
                },
                'push_staged_to_branch failed',
              );
              fs.writeFileSync(
                pushResultPath,
                JSON.stringify({
                  error: error.message,
                  stderr: stderr.slice(-500),
                }),
              );
              return;
            }
            logger.info(
              {
                sourceGroup,
                tileName: data.tileName,
                branch: data.branch,
              },
              'push_staged_to_branch pushed fixup',
            );
            fs.writeFileSync(
              pushResultPath,
              JSON.stringify({ stdout: stdout.trim() }),
            );
          },
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
