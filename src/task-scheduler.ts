import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import { stopContainer } from './container-runtime.js';
import { MAINTENANCE_SESSION_NAME } from './group-queue.js';
import { captureWedgeDiagnostics } from './wedge-diagnostics.js';
import {
  deleteTask,
  getAllTasks,
  getDormantRecurringTasks,
  getDueTasks,
  getTaskById,
  logAndUpdateTask,
  logTaskRun,
  pruneCompletedTasks,
  resurrectZombieTasks,
  setTaskSessionId,
  updateTask,
} from './db.js';
import { SqliteError } from 'better-sqlite3';
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
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
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
 * Hard cap on a single `runTask` invocation. If the container hasn't
 * produced a terminal status (success / error) by this point, the
 * watchdog kills the container by name and records the outcome as
 * `status='timeout'` in `task_run_logs`. Prevents the runaway pattern
 * #30 documents: a container that streams output but never resolves
 * keeps `runContainerAgent`'s output-resetting timeout fresh forever,
 * so the slot stays "active" indefinitely and every queued task on
 * that slot's group rots in `pendingTasks`.
 *
 * 30 min matches `CONTAINER_TIMEOUT`'s default — the longest a healthy
 * scheduled task should ever run. Configurable via
 * `NANOCLAW_TASK_RUN_TIMEOUT_MS` for ops who want a tighter cap.
 */
export const TASK_RUN_TIMEOUT_MS = (() => {
  const raw = process.env.NANOCLAW_TASK_RUN_TIMEOUT_MS;
  if (!raw) return 30 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30 * 60 * 1000;
  }
  return parsed;
})();

/**
 * Tracks the last time we logged a dormant warning per task id. Pruned
 * each cycle to drop ids that no longer exist in `scheduled_tasks` so
 * the map can't grow unbounded across the lifetime of the process.
 */
const lastDormantWarnAt = new Map<string, number>();

/**
 * Markers in a scheduled task's `result` payload that indicate the
 * gate script (or its precheck wrapper) hit a hard failure even though
 * the container reported `status: 'success'` upstream. The gate-script
 * exit-code IS the source of truth for these tasks (per the
 * `check-unanswered.py` docstring contract: exit 1 = hard failure), but
 * by the time the agent has wrapped the script's degraded payload into
 * an `<internal>...</internal>` reasoning block, the orchestrator only
 * sees the agent's "success" status. Reclassifying on these substrings
 * stops `task_run_logs` from logging script failures as `'success'` and
 * keeps the run-log table honest. Closes #26 (Fix B).
 *
 * - `DB access failed` — emitted by `check-unanswered.py` on
 *   `sqlite3.Error` (incl. "unable to open database file").
 * - `unable to open` — broader sqlite phrase that survives upstream
 *   wrapping; matches even when the precheck reformats the failure.
 * - `env-warning:` — non-fatal config drift the script surfaces in
 *   its `error` field; not a hard failure on its own, but a
 *   classification-correctness signal that something operator-visible
 *   is degraded. We treat it as `'error'` so the run shows up in
 *   "show me broken tasks" queries rather than vanishing into the
 *   green-on-green of a 207/207 success run.
 *
 * Substring matches, not regex — the markers are stable strings the
 * scripts emit verbatim. Case-insensitive to absorb future docstring
 * tweaks.
 */
const SCRIPT_FAILURE_MARKERS = [
  'DB access failed',
  'unable to open',
  'env-warning:',
] as const;

function resultIndicatesScriptFailure(result: string | null): boolean {
  if (!result) return false;
  const lower = result.toLowerCase();
  return SCRIPT_FAILURE_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  /**
   * Nested session cache: `folder → sessionName → sessionId`.
   * Scheduled tasks look up the MAINTENANCE slot's sessionId here so
   * consecutive heartbeat/nightly runs resume their own prior session
   * chain, not the user-facing default container's.
   */
  getSessions: () => Record<string, Record<string, string>>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    sessionName: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
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
    const error = err instanceof Error ? err.message : String(err);
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
    // The group was deregistered (or its registry row was manually removed)
    // between this task being scheduled and the dispatch tick that picked it
    // up. There is no live container to talk to and no future tick that
    // could change that — the task is permanently orphaned. Self-heal by
    // deleting it instead of erroring every poll interval forever (#52).
    //
    // Auto-deletion subsumes Option A's manual cleanup migration: any
    // pre-existing orphans (e.g. heartbeat-* rows whose group was removed
    // before this fix landed) are dropped on the next dispatch tick. The
    // sibling cleanup at deregister-time (when one exists) makes this code
    // path the second line of defence rather than the first.
    //
    // Logged at debug, not error: a missing group here is expected during
    // the brief window between registry removal and orphan cleanup, so it
    // is not actionable. If it ever signals something genuinely wrong, the
    // upstream registry-removal path is where the bug lives, not here.
    deleteTask(task.id);
    logger.debug(
      { taskId: task.id, groupFolder: task.group_folder },
      'Deleted orphaned task whose group is no longer registered',
    );
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

  // Per-task SDK session reuse (#59 / jbaruch#336). Recurring tasks
  // (cron / interval) keep their OWN `session_id` per task row across
  // fires so the API can cache the per-session message-history prefix
  // even though the prompt-cache TTL (5 min) expires between
  // heartbeat fires (15-30 min cadence). One-shot tasks
  // (`schedule_type === 'once'`) stay fresh-per-fire.
  //
  // The #193 cross-task bleed concern (where two distinct tasks
  // shared `sessions[group][maintenance]` and bled `last_result`)
  // does NOT apply: persistence here is keyed on `task_id`, so two
  // distinct tasks land in two distinct rows hence two distinct SDK
  // sessions — no slot-cache aliasing possible. The
  // `MAINTENANCE_SESSION_NAME` slot still routes maintenance work
  // into the parallel queue; the SDK session loaded inside that slot
  // is now per-task. `context_mode` stays inert on the schema.
  const isReusable = task.schedule_type !== 'once';
  const sessionId: string | undefined = isReusable
    ? (task.session_id ?? undefined)
    : undefined;
  let persistedSessionId: string | undefined = sessionId;

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

  // Per-task watchdog (#30 Part C): if `runContainerAgent` hasn't
  // resolved within TASK_RUN_TIMEOUT_MS, kill the container by name and
  // surface the result as `status='timeout'`. Container-runner already
  // has an output-resetting idle timeout, but a container that
  // continuously streams partial output (or silently spins) can keep
  // resetting it forever. The watchdog is a hard cap regardless of
  // output activity. The captured `containerName` comes from
  // `onProcess`, which container-runner invokes as soon as the spawn
  // returns — by the time the watchdog could ever fire, this is set.
  let runningContainerName: string | null = null;
  let watchdogFired = false;
  // Sentinel symbol the watchdog races against the runContainerAgent
  // promise. Using a unique symbol (not a string) means a malicious
  // container that returned the literal string by accident can't be
  // mistaken for a watchdog hit.
  const WATCHDOG_TIMEOUT = Symbol('watchdogTimeout');
  let watchdogResolve: (v: typeof WATCHDOG_TIMEOUT) => void;
  const watchdogPromise = new Promise<typeof WATCHDOG_TIMEOUT>((resolve) => {
    watchdogResolve = resolve;
  });
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true;
    const timeoutMin = Math.round(TASK_RUN_TIMEOUT_MS / 60_000);
    logger.error(
      {
        taskId: task.id,
        groupFolder: task.group_folder,
        containerName: runningContainerName,
        timeoutMs: TASK_RUN_TIMEOUT_MS,
      },
      'Task watchdog: killing container after hard timeout',
    );
    // Capture diagnostics BEFORE the kill: docker stats / exec / logs
    // / /proc/<pid>/wchan all need a live container to read from. The
    // helper is bounded to ~5s and best-effort; failure here must not
    // skip the kill below (#40 instrumentation).
    let diagPath: string | null = null;
    if (runningContainerName) {
      diagPath = captureWedgeDiagnostics(
        runningContainerName,
        {
          taskId: task.id,
          scheduleType: task.schedule_type,
          prompt: task.prompt,
          sessionId,
          runStartIso: new Date(startTime).toISOString(),
        },
        `task-timeout-${timeoutMin}min`,
      );
      stopContainer(runningContainerName);
    }
    const baseMsg = `task watchdog: killed container after ${timeoutMin}min`;
    error = diagPath ? `${baseMsg} (diag: ${diagPath})` : baseMsg;
    watchdogResolve(WATCHDOG_TIMEOUT);
  }, TASK_RUN_TIMEOUT_MS);

  try {
    const containerPromise = runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
        // Route every scheduled task into the parallel `maintenance` slot so
        // it runs concurrently with user-facing work. Sole writer of this
        // value — inbound paths route to `'default'` instead.
        sessionName: MAINTENANCE_SESSION_NAME,
        // Continuation marker for self-resuming cycles. NULL on
        // ordinary tasks; set only when a continuation-aware caller
        // scheduled this row as the next link of a chain.
        // Container-runner emits NANOCLAW_CONTINUATION=1 +
        // NANOCLAW_CONTINUATION_CYCLE_ID env vars iff this is non-empty.
        // `?? undefined` normalises the DB SELECT result (NULL for
        // ordinary rows) into the optional ContainerInput field shape —
        // never pass `null` here, since `if (continuationCycleId)` in
        // buildContainerArgs would treat the string `"null"` as truthy
        // if a stringification slipped in.
        continuationCycleId: task.continuation_cycle_id ?? undefined,
      },
      (proc, containerName) => {
        runningContainerName = containerName;
        deps.onProcess(
          task.chat_jid,
          MAINTENANCE_SESSION_NAME,
          proc,
          containerName,
          task.group_folder,
        );
      },
      async (streamedOutput: ContainerOutput) => {
        // Per-task session reuse (#59): persist `newSessionId` for
        // recurring tasks so the next fire can `resume:` it. The SDK
        // can re-issue the id mid-run; last-write-wins — the LATEST
        // id is the one whose JSONL is alive on disk. Once-tasks stay
        // fresh-per-fire (out of scope). Catches only SqliteError so
        // a transient DB hiccup degrades to "next fire starts fresh"
        // instead of wedging the scheduler loop.
        if (
          streamedOutput.newSessionId &&
          isReusable &&
          streamedOutput.newSessionId !== persistedSessionId
        ) {
          const newId = streamedOutput.newSessionId;
          try {
            setTaskSessionId(task.id, newId);
            persistedSessionId = newId;
          } catch (dbErr) {
            if (!(dbErr instanceof SqliteError)) throw dbErr;
            logger.error(
              { taskId: task.id, newSessionId: newId, err: dbErr },
              '[task-scheduler] setTaskSessionId failed during streaming — next fire will start fresh',
            );
          }
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Strip <internal> tags — suppress entirely if nothing remains
          const cleanResult = streamedOutput.result
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (cleanResult) {
            await deps.sendMessage(task.chat_jid, cleanResult);
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

    // Race the container's natural completion against the watchdog.
    // If the watchdog wins, `containerPromise` is left to settle in the
    // background — runContainerAgent's own cleanup hooks (the
    // `container.on('close')` path that fires after `stopContainer`)
    // will eventually run. We don't await it because by definition the
    // process is wedged from runTask's perspective.
    const raced = await Promise.race([containerPromise, watchdogPromise]);
    clearTimeout(watchdogTimer);
    if (closeTimer) clearTimeout(closeTimer);

    if (raced !== WATCHDOG_TIMEOUT) {
      const output = raced;
      // Terminal `newSessionId` — same per-task persistence as the
      // streaming path. Catches only SqliteError; any other throw
      // propagates to the outer try/catch and is logged as Task
      // failed.
      if (
        output.newSessionId &&
        isReusable &&
        output.newSessionId !== persistedSessionId
      ) {
        const newId = output.newSessionId;
        try {
          setTaskSessionId(task.id, newId);
          persistedSessionId = newId;
        } catch (dbErr) {
          if (!(dbErr instanceof SqliteError)) throw dbErr;
          logger.error(
            { taskId: task.id, newSessionId: newId, err: dbErr },
            '[task-scheduler] setTaskSessionId failed at terminal — next fire will start fresh',
          );
        }
      }

      if (output.status === 'error') {
        error = output.error || 'Unknown error';
      } else if (output.result) {
        // Result was already forwarded to the user via the streaming callback above
        result = output.result;
      }
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    clearTimeout(watchdogTimer);
    if (closeTimer) clearTimeout(closeTimer);
    // Watchdog already set `error` to the timeout message; preserve it
    // — the underlying `runContainerAgent` rejection here is just the
    // post-kill cleanup (e.g. spawn child exit), not the root cause.
    if (!watchdogFired) {
      error = err instanceof Error ? err.message : String(err);
    }
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  const nextRun = computeNextRun(task);

  // Reclassify gate-script failures that the container masked as success.
  // When the gate script (or its precheck) hits a hard error — e.g. the
  // untrusted-tier heartbeat losing read access to `messages.db` — the
  // agent dutifully writes the failure note inside `<internal>` tags and
  // the container reports `status: 'success'`. Without this check the
  // orchestrator would log every such run as `success`, hiding 96
  // wasted wake-ups/day on `heartbeat-telegram_old-wtf` (#26). Match
  // happens BEFORE the row is written so a single source of truth for
  // status flows into both `task_run_logs.status` and the user-visible
  // `last_result`/`Error: ...` summary.
  if (!error && resultIndicatesScriptFailure(result)) {
    error = `Script-gate failure detected in result payload: ${(result ?? '').slice(0, 200)}`;
    logger.warn(
      { taskId: task.id, group: task.group_folder },
      'Reclassified task run as error: gate-script failure marker present in result',
    );
  }

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';

  // Atomic: write the task_run_logs row AND update scheduled_tasks in a
  // single SQLite transaction. This enforces the single-writer invariant
  // that every last_run write is paired with a run-log row (closes #17).
  // Watchdog-fired runs are recorded as `'timeout'` (not `'error'`) so
  // the failure mode is queryable separately from script/agent errors —
  // #30 Part C distinguishes "the agent took too long" from "the agent
  // returned an error". Both still set `error` so `last_result` is
  // populated; only the `task_run_logs.status` enum differs.
  const runStatus: 'success' | 'error' | 'timeout' = watchdogFired
    ? 'timeout'
    : error
      ? 'error'
      : 'success';
  logAndUpdateTask(
    {
      task_id: task.id,
      duration_ms: durationMs,
      status: runStatus,
      result,
      error,
    },
    nextRun,
    resultSummary,
  );
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

  // Recover once-tasks that were pre-advanced to status='completed' but
  // whose dispatch never landed (host crash between the pre-advance write
  // and queue.enqueueTask, or queue dropped the run during shutdown). The
  // periodic pruneCompletedTasks pass would eventually GC these on age,
  // but that loses the schedule. Resurrecting puts them back in front of
  // getDueTasks so they actually run, even if late. Runs once per process
  // start, before the first loop tick.
  const resurrected = resurrectZombieTasks();
  if (resurrected.length > 0) {
    logger.warn(
      { count: resurrected.length, taskIds: resurrected },
      'Resurrected zombie once-tasks (status=completed, last_run=NULL) to active',
    );
  }

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
        const claimedNextRun = computeNextRun(currentTask);
        if (claimedNextRun !== null) {
          updateTask(currentTask.id, { next_run: claimedNextRun });
        } else {
          // once-task: mark completed before dispatch
          updateTask(currentTask.id, { status: 'completed' });
        }

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          MAINTENANCE_SESSION_NAME,
          () => runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
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
