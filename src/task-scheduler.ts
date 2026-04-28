import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import { MAINTENANCE_SESSION_NAME } from './group-queue.js';
import {
  getAllTasks,
  getDormantRecurringTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  pruneCompletedTasks,
  storeChatMetadata,
  storeMessage,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
/**
 * Result type that lets callers know WHY a recurring task got
 * `nextRun: null` so they can apply remediation against the FRESH DB
 * row (avoiding races against concurrent `update_task` IPC).
 *
 * The legacy `string | null` shape is preserved by `computeNextRun`
 * for backwards compat — call `computeNextRunDetailed` to get the
 * structured result.
 */
export type NextRunRemediation =
  | 'pause-broken-cron' // both per-task tz and TIMEZONE retry failed
  | 'clear-bad-timezone'; // per-task tz failed, TIMEZONE retry succeeded

export interface NextRunResult {
  nextRun: string | null;
  remediation?: NextRunRemediation;
}

export function computeNextRunDetailed(task: ScheduledTask): NextRunResult {
  if (task.schedule_type === 'once') return { nextRun: null };

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    // Per-task `schedule_timezone` (#102) takes precedence over the
    // server-wide TIMEZONE config. NULL/undefined falls back to TIMEZONE
    // — the pre-#102 behavior.
    //
    // Pure function (no DB writes): a previous version called
    // `updateTask` directly here, which raced with concurrent
    // `update_task` IPC — a user fixing a broken tz could have their
    // change clobbered by a still-in-flight scheduler tick that read
    // the old value. Now we just compute and report; the caller is
    // responsible for pausing or clearing the tz against the FRESH
    // DB row.
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, {
        tz: task.schedule_timezone || TIMEZONE,
      });
      return { nextRun: interval.next().toISOString() };
    } catch (err) {
      logger.warn(
        {
          taskId: task.id,
          scheduleValue: task.schedule_value,
          scheduleTimezone: task.schedule_timezone,
          err: err instanceof Error ? err.message : String(err),
        },
        'computeNextRun: cron parse failed — retrying with server TIMEZONE',
      );
      try {
        const interval = CronExpressionParser.parse(task.schedule_value, {
          tz: TIMEZONE,
        });
        return {
          nextRun: interval.next().toISOString(),
          remediation: 'clear-bad-timezone',
        };
      } catch (retryErr) {
        logger.error(
          {
            taskId: task.id,
            scheduleValue: task.schedule_value,
            err:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
          },
          'computeNextRun: cron parse failed even with TIMEZONE fallback',
        );
        return { nextRun: null, remediation: 'pause-broken-cron' };
      }
    }
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return { nextRun: new Date(now + 60_000).toISOString() };
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return { nextRun: new Date(next).toISOString() };
  }

  return { nextRun: null };
}

/**
 * Backwards-compat shim: `computeNextRun` retains its original
 * `string | null` shape so existing callers that don't care about
 * remediation hints continue to work. Internally delegates to
 * `computeNextRunDetailed` and discards the remediation field —
 * callers that DO need to act on remediation should call the
 * detailed variant directly and apply the remediation against the
 * fresh DB row (re-fetch via `getTaskById`) to avoid clobbering
 * concurrent IPC updates.
 */
export function computeNextRun(task: ScheduledTask): string | null {
  return computeNextRunDetailed(task).nextRun;
}

/**
 * Apply the remediation hint produced by `computeNextRunDetailed`
 * against the FRESH state of the task (re-fetched from DB). If the
 * task changed since the compute step (e.g. a concurrent
 * `update_task` fixed the cron expression or timezone), we skip the
 * remediation — the caller's fix wins.
 */
export function applyComputeNextRunRemediation(
  taskId: string,
  remediation: NextRunRemediation,
  observedScheduleValue: string,
  observedScheduleTimezone: string | null | undefined,
): void {
  const fresh = getTaskById(taskId);
  if (!fresh) return;
  // If the user updated the task between compute and now, the values
  // we'd be remediating against are no longer the source of the
  // failure. Skip — let the next scheduler tick re-evaluate.
  if (
    fresh.schedule_value !== observedScheduleValue ||
    (fresh.schedule_timezone ?? null) !== (observedScheduleTimezone ?? null)
  ) {
    logger.info(
      { taskId, remediation },
      'applyComputeNextRunRemediation: task changed since compute — skipping',
    );
    return;
  }
  if (remediation === 'pause-broken-cron') {
    updateTask(taskId, { status: 'paused' });
    logger.warn(
      { taskId },
      'Paused task — cron expression unparseable with both per-task tz and server TIMEZONE',
    );
  } else if (remediation === 'clear-bad-timezone') {
    updateTask(taskId, { schedule_timezone: null });
    logger.warn(
      { taskId, droppedTimezone: observedScheduleTimezone },
      'Dropped invalid schedule_timezone — falling back to TIMEZONE going forward',
    );
  }
}

/**
 * Default TTL for completed once-tasks. 24h is long enough that a user
 * can still find a recently-completed task in `list_tasks` output, short
 * enough that the table doesn't grow without bound. Cancellations
 * remove rows immediately via deleteTask; this only governs the
 * natural-completion path.
 *
 * The actual TTL passed to `pruneCompletedTasks` comes from
 * `getCompletedTaskTtlMs()`, which honours the
 * `NANOCLAW_COMPLETED_TASK_TTL_MS` env override on every read so tests
 * (and ops at runtime) can flip it without a process restart.
 */
export const COMPLETED_TASK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the active completed-task TTL: the env override
 * `NANOCLAW_COMPLETED_TASK_TTL_MS` if set to a positive integer
 * (milliseconds), otherwise the 24h default. Invalid / non-positive
 * env values fall back to the default and emit a warn log — the env
 * knob is for tuning, not for disabling the prune. Read on each
 * scheduler tick so changing the env between test cases (or via a
 * deploy-time config flip) takes effect without re-importing.
 */
export function getCompletedTaskTtlMs(): number {
  const raw = process.env.NANOCLAW_COMPLETED_TASK_TTL_MS;
  if (!raw) return COMPLETED_TASK_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { raw },
      'Invalid NANOCLAW_COMPLETED_TASK_TTL_MS; using 24h default',
    );
    return COMPLETED_TASK_TTL_MS;
  }
  return parsed;
}

/**
 * Minimum gap between successive `pruneCompletedTasks` calls. The
 * scheduler loop ticks every `SCHEDULER_POLL_INTERVAL` (seconds-scale)
 * but the prune query only deletes anything once a row has aged past
 * `COMPLETED_TASK_TTL_MS` (default 24h). Running it on every tick is
 * pure overhead — gate it to once per hour. The first tick after
 * process start always runs (see `lastPruneAt = 0` below) so we don't
 * skip the cleanup for an hour after a restart.
 */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Threshold past which an active recurring task is considered dormant
 * and worth a warn-level log. Long enough that the daily heartbeat /
 * morning-brief tasks always exceed any plausible `last_run` jitter,
 * short enough that a genuinely stuck cron is surfaced before the row
 * starts looking like it lives in the database for ornamental reasons.
 * Dormant rows are NOT auto-deleted — see `getDormantRecurringTasks`.
 */
export const DORMANT_CRON_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-task cooldown between consecutive dormant warnings. Without this,
 * every prune cycle (`PRUNE_INTERVAL_MS`, currently 1h) re-emits a warn
 * for the same dormant cron — 24 noisy logs/day per stuck task. One per
 * day per dormant task is enough to surface the problem without drowning
 * the log. After a process restart `lastDormantWarnAt` is empty, so the
 * first cycle warns once for every dormant task — that's the desired
 * behaviour: a fresh operator deserves to see the current state.
 */
export const DORMANT_WARN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Tracks the last time we logged a dormant warning per task id. Pruned
 * each cycle to drop ids that no longer exist in `scheduled_tasks` so
 * the map can't grow unbounded across the lifetime of the process.
 */
const lastDormantWarnAt = new Map<string, number>();

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    sessionName: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  /**
   * Wipe the on-disk session artifacts (JSONL transcript and the
   * sibling per-session tool-results directory) for a just-finished
   * scheduled-task SDK session. Each scheduled run is a fresh SDK turn
   * (#193) — its sessionId is never persisted to the sessions cache or
   * DB, so `nukeSession` and the time-based `cleanup-sessions.sh`
   * script cannot find it to wipe later. Without this hook, every run
   * leaves orphan files under
   * `data/sessions/<group>/maintenance/.claude/projects/<slug>/`.
   *
   * Invocation contract: the scheduler de-duplicates every `newSessionId`
   * the SDK reports during the run (streaming events plus the terminal
   * `runContainerAgent` return value, since either may carry the id, and
   * the SDK can re-issue the id mid-run) and calls this helper once per
   * unique id from a `finally` block that runs after the post-run DB
   * bookkeeping (`logTaskRun`, `updateTaskAfterRun`). The `finally`
   * placement guarantees the wipe still fires when those DB writes throw
   * — otherwise a transient SQLite error would leave the just-created
   * artifacts orphan-on-disk, defeating #193.
   *
   * Implemented by the orchestrator via `wipeSessionJsonl` (delete-
   * while-open is safe on POSIX, so we don't have to wait for container
   * teardown). The implementation is defensive — ENOENT and other
   * expected fs errors are swallowed internally and reflected in the
   * returned count. Returned count is the total number of filesystem
   * entries removed: up to 2 per slug (1 JSONL + 1 tool-results dir),
   * summed across every project-slug subdirectory walked.
   */
  wipeSessionJsonl: (
    groupFolder: string,
    sessionName: string,
    sessionId: string,
  ) => number;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    // resolveGroupFolderPath throws Error on path-validation failure.
    // Anything else is a bug elsewhere; propagate per
    // `jbaruch/coding-policy: error-handling`.
    if (!(err instanceof Error)) throw err;
    const error = err.message;
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
    !!group.containerConfig?.trusted,
  );

  let result: string | null = null;
  let error: string | null = null;

  // #193: scheduled tasks NEVER resume the SDK session. Every run starts
  // a fresh turn. Two distinct tasks (a lunch reminder firing minutes
  // after a heartbeat) used to share `sessions[group][maintenance]` and
  // the prior turn's terminal message bled into the next run's stream,
  // cross-attributing `last_result`. Containers still mount the
  // per-session `.claude/` dir under `MAINTENANCE_SESSION_NAME` (parallel
  // slot, won't block default), but no `resume: sessionId` is passed and
  // no `newSessionId` is persisted on completion. `context_mode` is
  // retained on the schema for future use; it no longer gates SDK resume.
  //
  // Disk hygiene: every fresh SDK turn writes a new JSONL transcript
  // under `data/sessions/<group>/maintenance/.claude/projects/<slug>/`.
  // Because the sessionId is no longer persisted, neither `nukeSession`
  // nor the time-based `cleanup-sessions.sh` script can find these
  // transcripts to wipe later. Collect every newSessionId observed
  // during the run (streaming events plus the terminal runContainerAgent
  // return) and pass them to `deps.wipeSessionJsonl` from the post-run
  // finally block — see `SchedulerDependencies` JSDoc.
  const observedSessionIds = new Set<string>();

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  // The kill grace after close sentinel is handled by GroupQueue.closeStdin().
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid, MAINTENANCE_SESSION_NAME);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
        // Provenance: the role that created this task, so the agent-runner
        // can decide whether to wrap the prompt in <untrusted-input>. Only
        // 'untrusted_agent'-created tasks get wrapped; owner/main/trusted
        // bypass. See ContainerInput.createdByRole docs.
        createdByRole: task.created_by_role,
        // Route every scheduled task into the parallel `maintenance` slot so
        // it runs concurrently with user-facing work. Sole writer of this
        // value — inbound paths route to `'default'` instead.
        sessionName: MAINTENANCE_SESSION_NAME,
        // Continuation marker for self-resuming cycles (#93/#130). NULL on
        // ordinary tasks; set only when the resumable-cycle helper skill
        // scheduled this row as the next link of a chain. Container-runner
        // emits NANOCLAW_CONTINUATION=1 + NANOCLAW_CONTINUATION_CYCLE_ID
        // env vars iff this is non-empty. `?? undefined` normalises the DB
        // SELECT result (NULL for ordinary rows) into the optional
        // ContainerInput field shape — never pass `null` here, since
        // `if (continuationCycleId)` in buildContainerArgs would treat the
        // string `"null"` as truthy if a stringification slipped in.
        continuationCycleId: task.continuation_cycle_id ?? undefined,
      },
      (proc, containerName) =>
        deps.onProcess(
          task.chat_jid,
          MAINTENANCE_SESSION_NAME,
          proc,
          containerName,
          task.group_folder,
        ),
      async (streamedOutput: ContainerOutput) => {
        // #193: do not persist newSessionId. Each scheduled run is a
        // standalone turn; persisting would re-introduce the cross-task
        // bleed via the next run's resume. Collect for post-run wipe so
        // the orphan JSONL doesn't accumulate under the maintenance slot.
        if (streamedOutput.newSessionId) {
          observedSessionIds.add(streamedOutput.newSessionId);
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Strip <internal> tags — suppress entirely if nothing remains
          const cleanResult = streamedOutput.result
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (cleanResult) {
            await deps.sendMessage(task.chat_jid, cleanResult);
            // Store the bot send so `messages.db` reflects every send
            // out of this session. Without this, scheduled-task sends
            // (heartbeat, housekeeping, morning-brief, etc.) reach
            // Telegram but leave no DB row — the "ghost heartbeat" /
            // "no trace in messages.db" class of jbaruch/nanoclaw#81.
            // The IPC-path `send_message` handler in src/ipc.ts writes
            // the same shape; this mirrors it so heartbeat's answered-
            // check accounting and forensic greps both see the row.
            //
            // Upsert chat metadata first so the `messages.chat_jid →
            // chats.jid` FK doesn't reject the insert on a chat that
            // has no prior metadata (task fires before any user
            // message, or chat was manually registered without the
            // normal group-sync write-through). Idempotent: existing
            // rows keep their `name` because we pass `name` as
            // undefined and `storeChatMetadata` omits `name` from the
            // UPDATE in that branch (not COALESCE); `channel` and
            // `is_group` are preserved via COALESCE when we pass
            // undefined for them. `last_message_time` advances to the
            // outgoing send's timestamp, same as the IPC path would
            // effectively do by chaining a chat-metadata update.
            //
            // Pass inferred `channel` + `isGroup` so a NEW chat row
            // (first-ever metadata write) has the right shape for
            // `getAvailableGroups()`, which filters on `is_group`.
            // Match the channel-name convention the codebase already
            // uses everywhere else (`'telegram'`, `'whatsapp'`) — NOT
            // the JID prefix abbreviation. JID shapes in this repo:
            //   - `tg:<id>` — Telegram. Negative id = group/channel,
            //     positive = private 1:1.
            //   - `<id>@g.us` — WhatsApp group (no `wa:` prefix).
            //   - `<id>@s.whatsapp.net` — WhatsApp DM.
            // Matches the conventions `db.ts`'s legacy-chat backfill
            // uses (`@g.us` → group, `@s.whatsapp.net` → DM).
            // Anything else: leave both undefined so COALESCE in
            // storeChatMetadata preserves existing values rather than
            // writing NULL or an abbreviated channel string.
            const sendTimestamp = new Date().toISOString();
            let inferredChannel: string | undefined;
            let inferredIsGroup: boolean | undefined;
            if (task.chat_jid.startsWith('tg:')) {
              inferredChannel = 'telegram';
              inferredIsGroup = task.chat_jid.startsWith('tg:-');
            } else if (task.chat_jid.endsWith('@g.us')) {
              inferredChannel = 'whatsapp';
              inferredIsGroup = true;
            } else if (task.chat_jid.endsWith('@s.whatsapp.net')) {
              inferredChannel = 'whatsapp';
              inferredIsGroup = false;
            }
            // Wrap the DB writes so a SQLite error (FK constraint,
            // disk full, schema mid-migration) never rejects the
            // `onOutput` promise. The streaming output chain in
            // `container-runner.ts` awaits this via `.then(...)` with
            // no `.catch(...)`, so a throw here can wedge the run
            // from ever resolving and stall the scheduler loop. The
            // send already succeeded; a missing DB row is recoverable
            // (at worst we'd get a duplicate in `unanswered` on the
            // next cycle) — stalling the scheduler is not.
            try {
              storeChatMetadata(
                task.chat_jid,
                sendTimestamp,
                undefined,
                inferredChannel,
                inferredIsGroup,
              );
              storeMessage({
                id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                chat_jid: task.chat_jid,
                sender: ASSISTANT_NAME,
                sender_name: ASSISTANT_NAME,
                content: cleanResult,
                timestamp: sendTimestamp,
                is_from_me: true,
                is_bot_message: true,
              });
            } catch (dbErr) {
              logger.error(
                {
                  taskId: task.id,
                  chatJid: task.chat_jid,
                  err: dbErr,
                  preview: cleanResult.slice(0, 200),
                },
                '[task-scheduler] storeChatMetadata/storeMessage failed after send — continuing, send already landed in Telegram',
              );
            }
          }
          // Don't close here — agent may still be polling for host script results.
          // Close only on final 'success' status below.
        }
        if (streamedOutput.status === 'success') {
          // No `notifyIdle` here — `notifyIdle` targets the `default` slot
          // only, so calling it from a maintenance-routed task would flip
          // the wrong container's state and could preempt active user work.
          // `scheduleClose` already winds this container down; when runTask
          // finishes, `drainGroup` chains any pending maintenance task.
          scheduleClose();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    // #193: terminal `output.newSessionId` is also discarded — see the
    // streaming-path comment above. Same fresh-turn invariant. Also
    // collected so the post-run wipe catches it even if no streaming
    // event delivered the same id.
    if (output.newSessionId) {
      observedSessionIds.add(output.newSessionId);
    }

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    // Per `jbaruch/coding-policy: error-handling`: non-Error throws
    // indicate bugs upstream and should propagate. The scheduler loop
    // (Step 2 of `loop` below) is the last-resort safety net that
    // catches them, logs, and keeps ticking — so re-throwing here
    // doesn't kill the orchestrator.
    if (!(err instanceof Error)) throw err;
    error = err.message;
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  // Post-run bookkeeping is wrapped in try/finally so the disk-hygiene
  // wipe still runs if any DB write throws (transient SQLite, disk
  // full, schema mid-migration). Without the finally a thrown
  // logTaskRun / updateTaskAfterRun would leave the just-created
  // JSONL orphan-on-disk forever — exactly what #193 is preventing.
  try {
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: error ? 'error' : 'success',
      result,
      error,
    });

    // Re-fetch the task to compute next_run against the FRESH schedule
    // fields. The captured `task` is from before dispatch — between
    // there and here a user can have called `update_task` to change
    // `schedule_value`, `schedule_timezone`, or `schedule_type`, and
    // their fix shouldn't be clobbered by a write-back computed from
    // the stale capture (the same race `applyComputeNextRunRemediation`
    // already guards against on the remediation path).
    const fresh = getTaskById(task.id) ?? task;
    const computed = computeNextRunDetailed(fresh);
    if (computed.remediation) {
      applyComputeNextRunRemediation(
        fresh.id,
        computed.remediation,
        fresh.schedule_value,
        fresh.schedule_timezone,
      );
    }
    const resultSummary = error
      ? `Error: ${error}`
      : result
        ? result.slice(0, 200)
        : 'Completed';
    updateTaskAfterRun(fresh.id, computed.nextRun, resultSummary);
  } finally {
    // #193: wipe the JSONL transcripts created by this run. The
    // sessionId is never persisted (no resume, no DB row), so without
    // this wipe the file accumulates forever under the maintenance
    // slot. Multiple ids are possible if the SDK re-issued
    // newSessionId mid-run — wipe all of them. No try/catch wrapper:
    // `wipeSessionJsonl` already swallows ENOENT and other expected
    // fs errors internally; anything that escapes is a programming
    // bug per `jbaruch/coding-policy: error-handling`, and propagation
    // is caught by the scheduler loop's terminal safety net.
    for (const sid of observedSessionIds) {
      deps.wipeSessionJsonl(task.group_folder, MAINTENANCE_SESSION_NAME, sid);
    }
  }
}

let schedulerRunning = false;
/**
 * Wall-clock timestamp (ms) of the most recent prune sweep. Initialised
 * to 0 so the first scheduler tick after process start always runs
 * cleanup. Updated unconditionally on each gated entry, even if the
 * prune itself touches zero rows — the cost we're throttling is the
 * SELECT, not the DELETE.
 */
let lastPruneAt = 0;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      // Run prune + dormant-cron sweep at most once per PRUNE_INTERVAL_MS.
      // The first tick after process start always passes this gate
      // (lastPruneAt initialised to 0), so a restart immediately runs
      // cleanup rather than waiting an hour. `lastPruneAt` is updated
      // AFTER the housekeeping calls succeed — if pruneCompletedTasks
      // or getDormantRecurringTasks throws, the next 60s tick retries
      // rather than gating the whole housekeeping cycle for an hour
      // on a transient DB error.
      const nowMs = Date.now();
      if (nowMs - lastPruneAt >= PRUNE_INTERVAL_MS) {
        const pruned = pruneCompletedTasks(getCompletedTaskTtlMs());
        if (pruned > 0) {
          logger.info({ count: pruned }, 'Pruned completed once-tasks');
        }
        // Dormant-cron visibility: log but never delete. A genuinely
        // stuck cron task points at a dispatch problem (next_run not
        // advancing, queue wedged) — surfacing it as a warn lets a
        // human decide; auto-deleting would silently lose the schedule.
        // Each task is warned at most once per DORMANT_WARN_COOLDOWN_MS
        // so a long-stuck cron doesn't spam the log on every cycle.
        const dormant = getDormantRecurringTasks(DORMANT_CRON_THRESHOLD_MS);
        const dormantIds = new Set<string>();
        for (const task of dormant) {
          dormantIds.add(task.id);
          const lastWarnedAt = lastDormantWarnAt.get(task.id) ?? 0;
          if (nowMs - lastWarnedAt < DORMANT_WARN_COOLDOWN_MS) {
            continue;
          }
          lastDormantWarnAt.set(task.id, nowMs);
          logger.warn(
            {
              taskId: task.id,
              groupFolder: task.group_folder,
              scheduleType: task.schedule_type,
              scheduleValue: task.schedule_value,
              lastRun: task.last_run,
              nextRun: task.next_run,
            },
            'Dormant recurring task — last_run older than threshold',
          );
        }
        // Drop bookkeeping for tasks that are no longer dormant (or no
        // longer exist) so the map can't grow without bound.
        for (const id of lastDormantWarnAt.keys()) {
          if (!dormantIds.has(id)) {
            lastDormantWarnAt.delete(id);
          }
        }
        lastPruneAt = nowMs;
      }

      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Pre-advance next_run before dispatch to prevent double-fire on crash.
        const computed = computeNextRunDetailed(currentTask);
        if (computed.remediation) {
          // Apply remediation against the FRESH DB row — if a user
          // raced an `update_task` IPC between the read above and
          // here that fixed the broken cron/tz, the helper detects
          // the mismatch and skips, letting the user's fix stand.
          applyComputeNextRunRemediation(
            currentTask.id,
            computed.remediation,
            currentTask.schedule_value,
            currentTask.schedule_timezone,
          );
        }
        if (computed.nextRun !== null) {
          updateTask(currentTask.id, { next_run: computed.nextRun });
        } else if (currentTask.schedule_type === 'once') {
          // Genuine once-task completion — pre-mark as completed.
          updateTask(currentTask.id, { status: 'completed' });
        }
        // else: cron/interval with nextRun=null means
        // `computeNextRunDetailed` returned a `pause-broken-cron`
        // remediation that the apply step above already handled.
        // Do NOT flip to completed — that would lose the paused
        // state set by the remediation. See #102 round-4 review.

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          MAINTENANCE_SESSION_NAME,
          () => runTask(currentTask, deps),
        );
      }
    } catch (err) {
      // Terminal safety net for the scheduler loop. Inner code paths
      // re-throw non-Error per `jbaruch/coding-policy: error-handling`;
      // this catch is where they finally land. Re-throwing further
      // here would crash the loop and stop every scheduled task — the
      // explicit design choice is "log and keep ticking" so a single
      // bug in one task can't take the orchestrator's whole scheduler
      // down. Distinguishes Error from non-Error in the log so the
      // bug source is identifiable downstream.
      if (err instanceof Error) {
        logger.error({ err }, 'Scheduler loop caught Error');
      } else {
        logger.error(
          { err: String(err) },
          'Scheduler loop caught non-Error throw — fix the upstream call site',
        );
      }
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
  lastPruneAt = 0;
  lastDormantWarnAt.clear();
}
