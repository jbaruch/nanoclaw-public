import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  DEFAULT_SESSION_NAME,
  sessionInputDirName,
} from './container-runner.js';
import { logger } from './logger.js';

// Re-export so callers that already imported it from group-queue keep working.
// Container-runner is the canonical definer — this file, the task-scheduler,
// and index.ts all need the same string, and the session-aware IPC mount
// lives in container-runner, so that's where the symbol originates.
export { DEFAULT_SESSION_NAME };

/**
 * Canonical session name for scheduled work (heartbeat, nightly, weekly,
 * reminders). `src/task-scheduler.ts` is the sole writer of this value;
 * no inbound path ever reaches it. Enforced by routing at call sites, not
 * by a runtime check — validated in tests.
 */
export const MAINTENANCE_SESSION_NAME = 'maintenance';

interface QueuedTask {
  id: string;
  groupJid: string;
  sessionName: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  groupJid: string;
  sessionName: string;
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  // Outcome of the most recent run on this slot. `null` means this slot
  // has never run (or hasn't run since process start). 'clean' means the
  // last run completed without throwing (and `processMessagesFn`
  // returned true for message runs); 'error' means it threw or returned
  // false. `getStatus()` uses this to distinguish 'crashed' from
  // 'not-spawned' when the slot is currently idle. Set in the `finally`
  // blocks of `runForGroup` and `runTask` — anywhere else and it would
  // race with active runs.
  lastExitStatus: 'clean' | 'error' | null;
}

/**
 * Per-(group, session) container status, derived from internal state.
 *
 * - `running` — container is alive and actively processing.
 * - `idle` — container is alive but waiting on idle-timeout / IPC input.
 * - `cooling-down` — short-term retry backoff in flight (`retryCount > 0`)
 *   OR long-term circuit-breaker cooldown active for this group folder.
 * - `crashed` — last attempted run failed and we're not in either cooldown
 *   window. Means the next inbound message will retry from scratch.
 * - `not-spawned` — slot has never run (since process start), or last
 *   run completed cleanly and nothing is in flight.
 */
export type ContainerStatus =
  | 'running'
  | 'idle'
  | 'cooling-down'
  | 'crashed'
  | 'not-spawned';

/**
 * GroupQueue tracks in-flight containers per `(groupJid, sessionName)` pair.
 * Two sessions for the same group (`default` + `maintenance`) can run
 * concurrently — each occupies its own slot. There is no global cap on
 * concurrent containers; with ~10 registered groups × 2 slots, the
 * theoretical ceiling is ~20, and the only real limit worth honouring is
 * the host's own (Docker, RAM, CPU). A global gate would just delay
 * legitimate work — e.g. a heartbeat firing concurrently with an inbound
 * user message on a different group.
 *
 * Method surface:
 * - `enqueueMessageCheck(groupJid)` and `sendMessage(groupJid, ...)` —
 *   user-facing paths, hardcoded to the `default` slot (inbound messages
 *   always route there).
 * - `notifyIdle(groupJid)` — also default-only; only the user-facing
 *   container runs the idle-waiting loop. Scheduled tasks exit on result.
 * - `enqueueTask(groupJid, id, sessionName, fn)` and
 *   `closeStdin(groupJid, sessionName?)` — session-selectable. The
 *   scheduler passes `MAINTENANCE_SESSION_NAME` for its writes;
 *   `closeStdin` defaults to `default` when called from a user-facing
 *   code path.
 */
export class GroupQueue {
  // Nested map: groupJid → sessionName → state. Two levels so we never
  // serialise `(groupJid, sessionName)` as a string anywhere — a JID that
  // happens to contain a delimiter like `::` would otherwise let two
  // different (jid, session) pairs collide onto the same GroupState.
  // Channel libs generate JIDs that don't naturally contain `::`, but
  // defence in depth: the storage structure forbids the collision by
  // construction.
  private groups = new Map<string, Map<string, GroupState>>();
  // Telemetry only — incremented on each spawn, decremented on each exit,
  // surfaced in debug logs and in the shutdown summary. Not gated against.
  private activeCount = 0;
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string, sessionName: string): GroupState {
    let sessions = this.groups.get(groupJid);
    if (!sessions) {
      sessions = new Map();
      this.groups.set(groupJid, sessions);
    }
    let state = sessions.get(sessionName);
    if (!state) {
      state = {
        groupJid,
        sessionName,
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        lastExitStatus: null,
      };
      sessions.set(sessionName, state);
    }
    return state;
  }

  // Read-only lookup. Unlike getGroup it doesn't lazily create the slot —
  // status queries about a never-run slot must not leave a phantom entry
  // in the map (chat_status iterates over registeredGroups, not the queue
  // map, so creating empties on every poll would just leak memory).
  private peekGroup(groupJid: string, sessionName: string): GroupState | null {
    return this.groups.get(groupJid)?.get(sessionName) ?? null;
  }

  /**
   * Return the derived status for a (group, session) slot. The
   * `circuitBreakerActive` flag is passed in by the caller because the
   * long-term circuit breaker lives on the orchestrator side (per group
   * folder, not per session) — `index.ts` owns it. Short-term retry
   * backoff (`retryCount > 0`) is internal and folded in here.
   *
   * A slot that has never run returns 'not-spawned'. A slot whose last
   * run errored AND is not currently in any cooldown window returns
   * 'crashed' — the next incoming message will retry from scratch.
   */
  getStatus(
    groupJid: string,
    sessionName: string,
    circuitBreakerActive = false,
  ): ContainerStatus {
    const state = this.peekGroup(groupJid, sessionName);
    if (!state) return 'not-spawned';
    if (state.active) {
      return state.idleWaiting ? 'idle' : 'running';
    }
    if (circuitBreakerActive || state.retryCount > 0) return 'cooling-down';
    if (state.lastExitStatus === 'error') return 'crashed';
    return 'not-spawned';
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  /**
   * Inbound user message arrived. Always routes to the `default` session —
   * user-facing Andy is the only one that responds to users.
   */
  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid, DEFAULT_SESSION_NAME);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  /**
   * Enqueue a scheduled task. `sessionName` determines which queue slot it
   * goes into:
   * - `'default'` (user-facing): serializes with inbound messages. Rarely
   *   needed — the user-facing session usually handles only IPC messages.
   * - `'maintenance'`: the parallel scheduled-task slot. The scheduler is
   *   the canonical writer of this value.
   */
  enqueueTask(
    groupJid: string,
    taskId: string,
    sessionName: string,
    fn: () => Promise<void>,
  ): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid, sessionName);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug(
        { groupJid, sessionName, taskId },
        'Task already running, skipping',
      );
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug(
        { groupJid, sessionName, taskId },
        'Task already queued, skipping',
      );
      return;
    }

    const task: QueuedTask = { id: taskId, groupJid, sessionName, fn };

    if (state.active) {
      state.pendingTasks.push(task);
      if (state.idleWaiting) {
        this.closeStdin(groupJid, sessionName);
      }
      logger.debug(
        { groupJid, sessionName, taskId },
        'Container active, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, sessionName, task).catch((err) =>
      logger.error(
        { groupJid, sessionName, taskId, err },
        'Unhandled error in runTask',
      ),
    );
  }

  registerProcess(
    groupJid: string,
    sessionName: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid, sessionName);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately. Idle-wait
   * only applies to user-facing containers (`default`), so `sessionName` is
   * implicit.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid, DEFAULT_SESSION_NAME);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid, DEFAULT_SESSION_NAME);
    }
  }

  /**
   * Send a follow-up message to the active user-facing container via IPC
   * file. Only writes when the user-facing (`default`) container is active.
   * Returns true if written, false otherwise.
   */
  sendMessage(
    groupJid: string,
    text: string,
    replyToMessageId?: string,
  ): boolean {
    const state = this.getGroup(groupJid, DEFAULT_SESSION_NAME);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    // Follow-ups always target the user-facing session's input dir — the
    // maintenance container's mount points at `input-maintenance/` and
    // therefore can't see messages dropped here. This is the whole point
    // of per-session input dirs.
    const inputDir = path.join(
      DATA_DIR,
      'ipc',
      state.groupFolder,
      sessionInputDirName(DEFAULT_SESSION_NAME),
    );
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      const data: Record<string, string> = { type: 'message', text };
      if (replyToMessageId) data.replyToMessageId = replyToMessageId;
      fs.writeFileSync(tempPath, JSON.stringify(data));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   * `sessionName` selects which container (default for user-message path,
   * maintenance can also be closed when pending tasks arrive idle).
   */
  closeStdin(
    groupJid: string,
    sessionName: string = DEFAULT_SESSION_NAME,
  ): void {
    const state = this.getGroup(groupJid, sessionName);
    if (!state.active || !state.groupFolder) return;

    // Session-scoped sentinel — writing `_close` to `input-default/` affects
    // only the default container; the maintenance container polls its own
    // `input-maintenance/` directory and is unaffected. `sessionInputDirName`
    // is called inside the try block because it throws on invalid
    // `sessionName`; letting the throw escape here would crash the queue
    // despite the surrounding catch being present.
    try {
      const inputDir = path.join(
        DATA_DIR,
        'ipc',
        state.groupFolder,
        sessionInputDirName(sessionName),
      );
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch (err) {
      logger.warn(
        { err, groupJid, sessionName },
        'closeStdin failed — stale container may linger until idle timeout',
      );
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    // Message-check runs always use the default session.
    const state = this.getGroup(groupJid, DEFAULT_SESSION_NAME);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    let runFailed = false;
    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          runFailed = true;
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      runFailed = true;
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      // Record outcome BEFORE drain so a status query that races a
      // chained drain run sees the slot's actual exit, not a stale null.
      state.lastExitStatus = runFailed ? 'error' : 'clean';
      this.activeCount--;
      this.drainGroup(groupJid, DEFAULT_SESSION_NAME);
    }
  }

  private async runTask(
    groupJid: string,
    sessionName: string,
    task: QueuedTask,
  ): Promise<void> {
    const state = this.getGroup(groupJid, sessionName);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      {
        groupJid,
        sessionName,
        taskId: task.id,
        activeCount: this.activeCount,
      },
      'Running queued task',
    );

    let runFailed = false;
    try {
      await task.fn();
    } catch (err) {
      runFailed = true;
      logger.error(
        { groupJid, sessionName, taskId: task.id, err },
        'Error running task',
      );
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.lastExitStatus = runFailed ? 'error' : 'clean';
      this.activeCount--;
      this.drainGroup(groupJid, sessionName);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string, sessionName: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid, sessionName);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, sessionName, task).catch((err) =>
        logger.error(
          { groupJid, sessionName, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages — only relevant on the default slot.
    if (sessionName === DEFAULT_SESSION_NAME && state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const sessions of this.groups.values()) {
      for (const state of sessions.values()) {
        if (state.process && !state.process.killed && state.containerName) {
          activeContainers.push(state.containerName);
        }
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
