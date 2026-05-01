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
  getTaskById,
  storeMessage,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { stripInternalTags } from './router.js';
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
  sendVoice?: (
    jid: string,
    text: string,
    voice: string,
    replyToMessageId?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
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
}

let ipcWatcherRunning = false;

/**
 * Path to the `_script_result_<requestId>.json` reply file the host writes
 * for an IPC request. Must land in the SAME session's input dir that the
 * requesting container mounts at `/workspace/ipc/input/` — otherwise the
 * container polls forever and the IPC call times out.
 *
 * The container-side MCP server stamps `sessionName` onto every TASKS_DIR
 * request (see `container/agent-runner/src/ipc-mcp-stdio.ts`). Older
 * containers that predate that change (or any request where the field is
 * missing) fall back to the default session — matches pre-parallel
 * behavior where only one session existed.
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
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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
                  let hostPath: string | undefined;
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
                  } else if (containerPath.startsWith('/workspace/extra/')) {
                    // additionalMounts land at /workspace/extra/<containerPath>.
                    // Resolve via the source group's mount config and verify
                    // the file falls inside that mount root (no path
                    // traversal — even though the host has the read, the
                    // chat couldn't have asked for it through normal flow).
                    const sourceJid = Object.keys(registeredGroups).find(
                      (j) => registeredGroups[j].folder === sourceGroup,
                    );
                    const mounts =
                      (sourceJid &&
                        registeredGroups[sourceJid]?.containerConfig
                          ?.additionalMounts) ||
                      [];
                    const rest = containerPath.replace('/workspace/extra/', '');
                    const slash = rest.indexOf('/');
                    const mountName =
                      slash === -1 ? rest : rest.slice(0, slash);
                    const tail = slash === -1 ? '' : rest.slice(slash + 1);
                    const mount = mounts.find((m) => {
                      const cp =
                        m.containerPath ||
                        path.basename(m.hostPath.replace(/\/+$/, ''));
                      return cp === mountName;
                    });
                    if (mount) {
                      const expandedHost = mount.hostPath.replace(
                        /^~(?=\/|$)/,
                        process.env.HOME || '',
                      );
                      const candidate = path.resolve(expandedHost, tail);
                      const root = path.resolve(expandedHost) + path.sep;
                      if (
                        candidate === path.resolve(expandedHost) ||
                        candidate.startsWith(root)
                      ) {
                        hostPath = candidate;
                      }
                    }
                  }
                  if (!hostPath) {
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
                    const cleanCaption = data.caption
                      ? stripInternalTags(data.caption)
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
                    // response. For cross-chat sends from main, this row
                    // lands in the TARGET chat's history (data.chatJid)
                    // — same as send_message, so downstream agents in
                    // the target chat see the artifact.
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
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC send_file attempt blocked',
                  );
                }
              } else if (
                data.type === 'send_voice' &&
                data.chatJid &&
                data.text &&
                deps.sendVoice
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Strip <internal> tags from text — voice can't render
                  // them and they shouldn't end up in db accounting either.
                  const cleanText = stripInternalTags(data.text || '');
                  if (cleanText) {
                    try {
                      await deps.sendVoice(
                        data.chatJid,
                        cleanText,
                        (data.voice as string) || 'alloy',
                        data.replyToMessageId,
                      );
                      // Store the spoken text in the DB so heartbeat /
                      // unanswered-checks see this as a real reply (same
                      // as send_file caption + send_message).
                      storeMessage({
                        id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                        chat_jid: data.chatJid,
                        sender: ASSISTANT_NAME,
                        sender_name: ASSISTANT_NAME,
                        content: `[Voice: ${cleanText}]`,
                        timestamp: new Date().toISOString(),
                        is_from_me: true,
                        is_bot_message: true,
                        reply_to_message_id: data.replyToMessageId,
                      });
                      logger.info(
                        {
                          chatJid: data.chatJid,
                          chars: cleanText.length,
                          voice: data.voice,
                          sourceGroup,
                        },
                        'IPC voice sent',
                      );
                    } catch (err) {
                      logger.error(
                        { err, chatJid: data.chatJid },
                        'send_voice failed',
                      );
                    }
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC send_voice attempt blocked',
                  );
                }
              } else if (data.type === 'message' && data.chatJid && data.text) {
                // Strip <internal> tags — if nothing remains, skip silently
                const cleanText = data.text
                  .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                  .trim();
                if (!cleanText) {
                  logger.debug(
                    { sourceGroup },
                    'IPC message suppressed (all internal)',
                  );
                  fs.unlinkSync(filePath);
                  continue;
                }

                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  let sendOk: boolean;
                  // Lifted out of the else-branch so the storeMessage
                  // call below can use it as the row id when the
                  // channel surfaces the platform's native message id
                  // (currently only the non-pool sendMessage path).
                  // See #50.
                  let sentMsgId: string | void = undefined;
                  if (data.sender && data.chatJid.startsWith('tg:')) {
                    sendOk = await sendPoolMessage(
                      data.chatJid,
                      cleanText,
                      data.sender,
                      sourceGroup,
                    );
                  } else {
                    sentMsgId = await deps.sendMessage(
                      data.chatJid,
                      cleanText,
                      data.replyToMessageId,
                    );
                    sendOk = !!sentMsgId;
                    // Pin the message if requested
                    if (data.pin && sentMsgId && deps.pinMessage) {
                      await deps.pinMessage(data.chatJid, sentMsgId);
                    }
                  }
                  // Only record the bot response in messages.db if
                  // delivery actually landed. The Telegram channel
                  // swallows API errors (cross-chat reply_to, rate
                  // limits, blocked-by-user) and returns a falsy
                  // value; without this gate we would write a `bot-…`
                  // row for every send attempt, including failures.
                  // Heartbeat treats those rows as "the agent
                  // answered" and downstream agents that quote-reply
                  // hallucinate a thread that never existed.
                  if (sendOk) {
                    // Prefer the platform-native numeric message id
                    // when the channel returned one (Telegram does;
                    // the pool path doesn't). Storing the numeric id
                    // as the row's primary key means a later
                    // `sendReaction` lookup by that id finds the row
                    // directly — no translation table needed. Legacy
                    // `bot-<ts>-<rand>` is the fallback for paths
                    // that don't surface a numeric id, e.g.
                    // sendPoolMessage which returns a boolean — see
                    // #50 for the audit. is_from_me=1 +
                    // is_bot_message=1 are still the canonical
                    // markers; nothing in the codebase parses the id
                    // prefix.
                    const sentNumericId =
                      typeof sentMsgId === 'string' && /^\d+$/.test(sentMsgId)
                        ? sentMsgId
                        : null;
                    storeMessage({
                      id:
                        sentNumericId ??
                        `bot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                      chat_jid: data.chatJid,
                      sender: data.sender || ASSISTANT_NAME,
                      sender_name: data.sender || ASSISTANT_NAME,
                      content: cleanText,
                      timestamp: new Date().toISOString(),
                      is_from_me: true,
                      is_bot_message: true,
                      reply_to_message_id: data.replyToMessageId,
                    });
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC message sent',
                    );
                  } else {
                    logger.error(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC message send failed; not storing bot row',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
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
    // For set_agent_model: target group folder + the override value.
    // `agentModel: null` clears the override; a string sets it. Validation
    // (prefix regex, fallback) happens at spawn time in container-runner,
    // not here — keeps the IPC handler permissive so the operator can
    // store an experimental model name and discover at spawn time whether
    // the SDK accepts it.
    agentModel?: string | null;
    // For host operations / github_backup / promote_staging
    requestId?: string;
    message?: string;
    tileName?: string;
    skillName?: string;
    slug?: string;
    filter?: Record<string, boolean>;
    dryRun?: boolean;
    command?: string;
    payload?: string | Record<string, unknown>;
    confirm?: boolean;
    /**
     * Continuation marker for self-resuming cycles. Set by a
     * continuation-aware caller when scheduling the next link of a
     * chain via `schedule_task`. Persisted onto the scheduled_tasks
     * row verbatim; surfaced to the spawned container at fire time as
     * `NANOCLAW_CONTINUATION=1` + `NANOCLAW_CONTINUATION_CYCLE_ID=<value>`.
     * Free-form opaque slot key, but type-narrowed to string for
     * safety; non-string values are dropped at the handler.
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

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
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
          // Reject past once-schedules at creation time. Without this,
          // the row lands in the DB with `next_run` already in the past,
          // the scheduler picks it up on the next tick, pre-advances it
          // to status='completed' (the once-task path in startSchedulerLoop
          // marks completed BEFORE dispatch), and if dispatch then drops
          // (wedged maintenance slot, host crash) the task is silently
          // gone — recorded as completed, but never actually ran.
          // Closes #30 Part A: catch the highest-signal user-facing case
          // (typo / TZ confusion) at the IPC boundary so the caller
          // learns immediately the schedule didn't take.
          const nowMs = Date.now();
          if (date.getTime() <= nowMs) {
            logger.warn(
              {
                taskId: data.taskId,
                sourceGroup,
                targetFolder,
                scheduleValue: data.schedule_value,
                parsedAt: date.toISOString(),
                nowAt: new Date(nowMs).toISOString(),
              },
              'Rejecting once-task: schedule_value is in the past — once-tasks must be scheduled in the future',
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
        // Optional continuation marker. Set by a continuation-aware
        // caller when scheduling the next link of a self-resuming
        // cycle chain; the task-scheduler reads it at fire time and
        // plumbs the matching env vars onto the spawned container.
        // Untyped non-string values are dropped — the field is a
        // free-form opaque slot key, but we never want a stray number
        // / object to land in the DB column.
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
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
          continuation_cycle_id: continuationCycleId,
        });
        logger.info(
          {
            taskId,
            sourceGroup,
            targetFolder,
            contextMode,
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

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
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
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
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

    case 'set_agent_model': {
      // Per-group AGENT_MODEL override. Only main can change models for
      // arbitrary groups; non-main can only set its own. The handler
      // mutates ONLY `containerConfig.agentModel`, preserving all other
      // ContainerConfig fields (additionalMounts, timeout, trusted, etc.)
      // so an operator setting agentModel can't accidentally clobber the
      // group's mount allowlist or trust flag.
      if (!data.groupFolder) {
        logger.warn(
          { sourceGroup },
          'Invalid set_agent_model request - missing groupFolder',
        );
        break;
      }
      // `agentModel` may be `null` (clear), `undefined` (no-op-ish but
      // treated the same as clear for predictability), or a string. Any
      // other type → reject.
      if (
        data.agentModel !== null &&
        data.agentModel !== undefined &&
        typeof data.agentModel !== 'string'
      ) {
        logger.warn(
          { sourceGroup, agentModelType: typeof data.agentModel },
          'Invalid set_agent_model request - agentModel must be string or null',
        );
        break;
      }
      const targetFolder = data.groupFolder;
      if (!isMain && targetFolder !== sourceGroup) {
        logger.warn(
          { sourceGroup, targetFolder },
          'Unauthorized set_agent_model attempt blocked',
        );
        break;
      }
      // Find the registered group by folder.
      const targetEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === targetFolder,
      );
      if (!targetEntry) {
        logger.warn(
          { sourceGroup, targetFolder },
          'set_agent_model: target group not registered',
        );
        break;
      }
      const [targetJid, targetGroup] = targetEntry;
      // Build the new containerConfig, preserving every existing field
      // and ONLY touching agentModel. If the resulting config is empty
      // (no fields set), persist undefined so the column lands as NULL
      // rather than `{}`.
      const prevConfig = targetGroup.containerConfig ?? {};
      const nextConfig: NonNullable<RegisteredGroup['containerConfig']> = {
        ...prevConfig,
      };
      if (data.agentModel === null || data.agentModel === undefined) {
        delete nextConfig.agentModel;
      } else {
        nextConfig.agentModel = data.agentModel;
      }
      const hasAnyField = Object.keys(nextConfig).length > 0;
      const updated: RegisteredGroup = {
        ...targetGroup,
        containerConfig: hasAnyField ? nextConfig : undefined,
      };
      deps.registerGroup(targetJid, updated);
      logger.info(
        {
          sourceGroup,
          targetFolder,
          agentModel: data.agentModel ?? null,
        },
        data.agentModel
          ? 'Per-group AGENT_MODEL override set via IPC'
          : 'Per-group AGENT_MODEL override cleared via IPC',
      );
      // Refresh snapshot so the new config is visible to peers
      const availableGroups = deps.getAvailableGroups();
      deps.writeGroupsSnapshot(
        sourceGroup,
        isMain,
        availableGroups,
        new Set(Object.keys(registeredGroups)),
      );
      break;
    }

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
            timeout: 300_000,
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
                'promote_staging pushed to tile repo',
              );
              fs.writeFileSync(
                promoteResultPath,
                JSON.stringify({ stdout: stdout.trim() }),
              );

              // Schedule tessl update + session clear after GHA completes (~5 min)
              setTimeout(() => {
                logger.info('Running post-promote tessl update');
                const tesslDir = path.resolve(process.cwd(), 'tessl-workspace');
                execFile(
                  'bash',
                  [
                    '-c',
                    `cd "${tesslDir}" && tessl update --yes --dangerously-ignore-security --agent claude-code 2>&1`,
                  ],
                  { timeout: 120_000 },
                  (updateErr, updateStdout) => {
                    if (updateErr) {
                      logger.error(
                        { error: updateErr.message },
                        'Post-promote tessl update failed',
                      );
                    } else {
                      const cleared = deleteAllSessions();
                      logger.info(
                        {
                          sessionsCleared: cleared,
                          output: updateStdout.trim().slice(-200),
                        },
                        'Post-promote tessl update completed — sessions cleared',
                      );
                    }
                  },
                );
              }, 300_000); // 5 minutes
            }
          },
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
