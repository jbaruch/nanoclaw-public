import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock container-runner BEFORE importing task-scheduler so the scheduler
// picks up the mocked `runContainerAgent`. We can't actually spawn a
// container in a unit test, so this fake calls the streaming callback
// with whatever output the test-under-test wants to simulate.
//
// `vi.hoisted` is required because `vi.mock(...)` itself is hoisted to
// the top of the file — a plain top-level `const` would be accessed
// before initialisation inside the factory.
const { mockRunContainerAgent } = vi.hoisted(() => ({
  mockRunContainerAgent: vi.fn(),
}));
vi.mock('./container-runner.js', () => ({
  runContainerAgent: mockRunContainerAgent,
  writeTasksSnapshot: vi.fn(),
  DEFAULT_SESSION_NAME: 'default',
}));

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getSession,
  getTaskById,
  pruneCompletedTasks,
  setSession,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import {
  COMPLETED_TASK_TTL_MS,
  DORMANT_CRON_THRESHOLD_MS,
  DORMANT_WARN_COOLDOWN_MS,
  PRUNE_INTERVAL_MS,
  _resetSchedulerLoopForTests,
  computeNextRun,
  getCompletedTaskTtlMs,
  startSchedulerLoop,
} from './task-scheduler.js';
import { logger } from './logger.js';
import type { ContainerOutput } from './container-runner.js';
import { MAINTENANCE_SESSION_NAME } from './group-queue.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    mockRunContainerAgent.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (
        _groupJid: string,
        _taskId: string,
        _sessionName: string,
        fn: () => Promise<void>,
      ) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('maintenance task with context_mode=group uses stored maintenance sessionId and persists newSessionId', async () => {
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };

    // Seed a prior maintenance sessionId in the sessions cache. The
    // scheduler should read this and pass it into runContainerAgent.
    setSession('main', MAINTENANCE_SESSION_NAME, 'prior-maint-session');

    createTask({
      id: 'group-ctx-task',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    mockRunContainerAgent.mockImplementation(
      async (_group, _input, _onProc, onOutput) => {
        // Simulate a streamed success with a new sessionId — this is what
        // the container-runner reports back after the SDK's query() resolves.
        await onOutput({
          status: 'success',
          result: 'ok',
          newSessionId: 'new-maint-session',
        } as ContainerOutput);
        return { status: 'success', result: 'ok' };
      },
    );

    const enqueueTask = vi.fn(
      (
        _groupJid: string,
        _taskId: string,
        _sessionName: string,
        fn: () => Promise<void>,
      ) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({ 'main@g.us': MAIN_GROUP }),
      getSessions: () => ({ main: { maintenance: 'prior-maint-session' } }),
      queue: { enqueueTask, closeStdin: vi.fn() } as never,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    // The stored prior sessionId was passed in as the resume target.
    expect(mockRunContainerAgent).toHaveBeenCalled();
    const containerInput = mockRunContainerAgent.mock.calls[0][1];
    expect(containerInput.sessionId).toBe('prior-maint-session');
    expect(containerInput.sessionName).toBe(MAINTENANCE_SESSION_NAME);

    // The new sessionId from the streaming callback was persisted to the
    // MAINTENANCE slot (not default).
    expect(getSession('main', MAINTENANCE_SESSION_NAME)).toBe(
      'new-maint-session',
    );
    expect(getSession('main', 'default')).toBeUndefined();
  });

  it('maintenance task with context_mode=isolated does NOT persist newSessionId', async () => {
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };

    // No prior sessionId in the cache for isolated tasks.
    createTask({
      id: 'isolated-task',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    mockRunContainerAgent.mockImplementation(
      async (_group, _input, _onProc, onOutput) => {
        await onOutput({
          status: 'success',
          result: 'ok',
          newSessionId: 'should-not-be-persisted',
        } as ContainerOutput);
        return { status: 'success', result: 'ok' };
      },
    );

    const enqueueTask = vi.fn(
      (
        _groupJid: string,
        _taskId: string,
        _sessionName: string,
        fn: () => Promise<void>,
      ) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({ 'main@g.us': MAIN_GROUP }),
      getSessions: () => ({}),
      queue: { enqueueTask, closeStdin: vi.fn() } as never,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    // Isolated tasks start fresh — no sessionId passed in.
    const containerInput = mockRunContainerAgent.mock.calls[0][1];
    expect(containerInput.sessionId).toBeUndefined();

    // And the streamed newSessionId was NOT persisted — an isolated task
    // finishing must not contaminate the maintenance slot's chain.
    expect(getSession('main', MAINTENANCE_SESSION_NAME)).toBeUndefined();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('pruneCompletedTasks removes once-tasks whose last_run is older than TTL', () => {
    const t0 = new Date('2026-04-01T00:00:00.000Z').getTime();
    vi.setSystemTime(t0);
    createTask({
      id: 'old-completed',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'old',
      schedule_type: 'once',
      schedule_value: new Date(t0).toISOString(),
      context_mode: 'isolated',
      next_run: new Date(t0).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    // Mimic scheduler's terminal write-back: nextRun=null marks it completed
    // and stamps last_run with the current (mocked) time.
    updateTaskAfterRun('old-completed', null, 'ok');

    // Fast-forward past the TTL boundary; prune should now match.
    vi.setSystemTime(t0 + COMPLETED_TASK_TTL_MS + 60_000);

    const removed = pruneCompletedTasks(COMPLETED_TASK_TTL_MS);
    expect(removed).toBe(1);
    expect(getTaskById('old-completed')).toBeUndefined();
  });

  it('pruneCompletedTasks preserves once-tasks completed within the TTL window', () => {
    createTask({
      id: 'recent-completed',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'recent',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    updateTaskAfterRun('recent-completed', null, 'ok');

    const removed = pruneCompletedTasks(COMPLETED_TASK_TTL_MS);
    expect(removed).toBe(0);
    expect(getTaskById('recent-completed')).toBeDefined();
  });

  it('pruneCompletedTasks never touches active tasks regardless of age', () => {
    const old = new Date(Date.now() - COMPLETED_TASK_TTL_MS * 10).toISOString();
    createTask({
      id: 'stale-active',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'still active',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: old,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const removed = pruneCompletedTasks(COMPLETED_TASK_TTL_MS);
    expect(removed).toBe(0);
    expect(getTaskById('stale-active')).toBeDefined();
  });
  it('pruneCompletedTasks removes completed once-task with NULL last_run when created_at is past TTL', () => {
    // Reproduces task-1777292573285-gvr365: status=completed, schedule_type=once,
    // last_run=NULL. Pre-fix the `last_run IS NOT NULL` guard left this row
    // lingering forever; the COALESCE(last_run, created_at) version uses the
    // creation timestamp as the fallback age signal.
    const t0 = Date.parse('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    createTask({
      id: 'orphan-completed',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'never ran',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      // Backdate creation past the TTL boundary.
      created_at: new Date(t0 - COMPLETED_TASK_TTL_MS - 60_000).toISOString(),
    });
    // Mark completed WITHOUT going through updateTaskAfterRun — that's the
    // dispatch-failure shape the bug describes. last_run stays NULL.
    updateTask('orphan-completed', { status: 'completed' });

    const before = getTaskById('orphan-completed');
    expect(before?.status).toBe('completed');
    expect(before?.last_run ?? null).toBeNull();

    const removed = pruneCompletedTasks(COMPLETED_TASK_TTL_MS);
    expect(removed).toBe(1);
    expect(getTaskById('orphan-completed')).toBeUndefined();
  });

  it('getCompletedTaskTtlMs honours NANOCLAW_COMPLETED_TASK_TTL_MS env override', () => {
    // Default — no env var.
    vi.stubEnv('NANOCLAW_COMPLETED_TASK_TTL_MS', '');
    expect(getCompletedTaskTtlMs()).toBe(COMPLETED_TASK_TTL_MS);

    // Valid override.
    vi.stubEnv('NANOCLAW_COMPLETED_TASK_TTL_MS', '60000');
    expect(getCompletedTaskTtlMs()).toBe(60_000);

    // Invalid override falls back to the default, doesn't throw.
    vi.stubEnv('NANOCLAW_COMPLETED_TASK_TTL_MS', 'not-a-number');
    expect(getCompletedTaskTtlMs()).toBe(COMPLETED_TASK_TTL_MS);
    vi.stubEnv('NANOCLAW_COMPLETED_TASK_TTL_MS', '-1');
    expect(getCompletedTaskTtlMs()).toBe(COMPLETED_TASK_TTL_MS);
    // 0 is rejected too — "prune everything immediately" is never what
    // the operator meant, and silently honouring it complicates triage.
    vi.stubEnv('NANOCLAW_COMPLETED_TASK_TTL_MS', '0');
    expect(getCompletedTaskTtlMs()).toBe(COMPLETED_TASK_TTL_MS);

    // End-to-end: with the env override active, prune deletes a row that
    // would NOT have matched the 24h default.
    const t0 = Date.parse('2026-02-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    createTask({
      id: 'env-ttl-task',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'env',
      schedule_type: 'once',
      schedule_value: '2026-02-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(t0).toISOString(),
      status: 'active',
      created_at: new Date(t0).toISOString(),
    });
    updateTaskAfterRun('env-ttl-task', null, 'ok');

    // 5 minutes later — well within the 24h default, well past a 60s override.
    vi.setSystemTime(t0 + 5 * 60_000);
    vi.stubEnv('NANOCLAW_COMPLETED_TASK_TTL_MS', '60000');
    expect(pruneCompletedTasks(getCompletedTaskTtlMs())).toBe(1);

    vi.unstubAllEnvs();
  });

  it('scheduler loop runs prune at most once per PRUNE_INTERVAL_MS even on many ticks', async () => {
    // Spy on pruneCompletedTasks via the scheduler's call-site by counting
    // INFO logs of "Pruned completed once-tasks" — the scheduler only logs
    // when count > 0. To make the count > 0 every gated entry, seed two
    // expired completed once-tasks; each gated call deletes one of them.
    const t0 = Date.parse('2026-03-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    for (const id of ['p1', 'p2']) {
      createTask({
        id,
        group_folder: 'main',
        chat_jid: 'main@g.us',
        prompt: id,
        schedule_type: 'once',
        schedule_value: new Date(t0).toISOString(),
        context_mode: 'isolated',
        next_run: new Date(t0).toISOString(),
        status: 'active',
        created_at: new Date(t0 - COMPLETED_TASK_TTL_MS - 60_000).toISOString(),
      });
      updateTask(id, { status: 'completed' });
    }

    const infoSpy = vi.spyOn(logger, 'info');

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask: vi.fn(), closeStdin: vi.fn() } as never,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    // SCHEDULER_POLL_INTERVAL is 60s — advance in poll-sized steps so
    // each iteration fires a real loop tick. 30 ticks = 30 minutes,
    // still well below the 1h PRUNE_INTERVAL_MS gate. Only the first
    // tick (lastPruneAt=0) should pass the gate.
    for (let i = 0; i < 30; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    const prunedLogCalls = infoSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === 'string' &&
        call[1] === 'Pruned completed once-tasks',
    );
    // 30 ticks covered ~30s of wall-clock time, well under PRUNE_INTERVAL_MS.
    // Even though both seeded rows are eligible, the throttle means at most
    // ONE prune call across all ticks → exactly one "Pruned" log line.
    expect(prunedLogCalls.length).toBe(1);
    // Both seeded rows were eligible at the first gated tick, so a single
    // prune transaction took both out.
    expect(getTaskById('p1')).toBeUndefined();
    expect(getTaskById('p2')).toBeUndefined();

    // Seed another expired completed once-task so the next gated entry has
    // something to log, then cross the PRUNE_INTERVAL_MS boundary.
    const tNow = Date.now();
    createTask({
      id: 'p3',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'p3',
      schedule_type: 'once',
      schedule_value: new Date(tNow).toISOString(),
      context_mode: 'isolated',
      next_run: new Date(tNow).toISOString(),
      status: 'active',
      created_at: new Date(tNow - COMPLETED_TASK_TTL_MS - 60_000).toISOString(),
    });
    updateTask('p3', { status: 'completed' });

    await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);

    const prunedAfterBoundary = infoSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === 'string' &&
        call[1] === 'Pruned completed once-tasks',
    );
    expect(prunedAfterBoundary.length).toBeGreaterThanOrEqual(2);
    expect(getTaskById('p3')).toBeUndefined();

    infoSpy.mockRestore();
  });

  it('dormant recurring task (last_run > threshold, status=active) emits a warn log without deletion', async () => {
    // A cron task that hasn't fired in 8 days while still status=active
    // points at a dispatch problem. The scheduler should log a warning so
    // a human notices, but must NOT auto-delete the row — that would
    // silently lose the schedule.
    const t0 = Date.parse('2026-04-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    createTask({
      id: 'dormant-cron',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'morning brief',
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
      context_mode: 'group',
      next_run: new Date(t0 + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    // Stamp last_run > DORMANT_CRON_THRESHOLD_MS in the past.
    updateTaskAfterRun(
      'dormant-cron',
      new Date(t0 + 60_000).toISOString(),
      'ok',
    );
    // updateTaskAfterRun stamps last_run to "now". Roll the clock forward
    // past the dormant threshold so the row qualifies on the next tick.
    vi.setSystemTime(t0 + DORMANT_CRON_THRESHOLD_MS + 60 * 60_000);

    const warnSpy = vi.spyOn(logger, 'warn');

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask: vi.fn(), closeStdin: vi.fn() } as never,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const dormantWarnCall = warnSpy.mock.calls.find(
      (call) =>
        typeof call[1] === 'string' &&
        call[1].startsWith('Dormant recurring task'),
    );
    expect(dormantWarnCall).toBeDefined();
    expect((dormantWarnCall![0] as { taskId: string }).taskId).toBe(
      'dormant-cron',
    );

    // The row is still in the database — visibility-only, no delete.
    expect(getTaskById('dormant-cron')).toBeDefined();
    warnSpy.mockRestore();
  });

  it('dormant warn is rate-limited per task to once per DORMANT_WARN_COOLDOWN_MS', async () => {
    // Without per-task dedup the prune sweep (PRUNE_INTERVAL_MS = 1h)
    // would re-warn the same dormant task 24 times a day. Assert that
    // back-to-back prune cycles only emit one warn for the same id, and
    // that the warn fires again once the cooldown elapses.
    const t0 = Date.parse('2026-04-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    createTask({
      id: 'dormant-dedup',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'morning brief',
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
      context_mode: 'group',
      next_run: new Date(t0 + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    updateTaskAfterRun(
      'dormant-dedup',
      new Date(t0 + 60_000).toISOString(),
      'ok',
    );
    // Move past the dormancy threshold so the task qualifies.
    vi.setSystemTime(t0 + DORMANT_CRON_THRESHOLD_MS + 60 * 60_000);

    const warnSpy = vi.spyOn(logger, 'warn');

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask: vi.fn(), closeStdin: vi.fn() } as never,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    await vi.advanceTimersByTimeAsync(10);

    const matches = () =>
      warnSpy.mock.calls.filter(
        (call) =>
          typeof call[1] === 'string' &&
          call[1].startsWith('Dormant recurring task') &&
          (call[0] as { taskId: string }).taskId === 'dormant-dedup',
      ).length;

    expect(matches()).toBe(1);

    // A second prune cycle inside the cooldown window must NOT warn again.
    await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS + 10);
    expect(matches()).toBe(1);

    // After the cooldown elapses, the next prune cycle warns once more.
    await vi.advanceTimersByTimeAsync(DORMANT_WARN_COOLDOWN_MS);
    expect(matches()).toBe(2);

    warnSpy.mockRestore();
  });

  it('dormant warn map drops entries for tasks that no longer exist', async () => {
    // The dedup map is keyed by task id; if a task is deleted between
    // prune cycles, its entry must be cleaned up so the map can't grow
    // unbounded over the lifetime of the process. We can't poke at the
    // map directly, so we assert the externally-visible behaviour: a
    // re-created task with the same id (after deletion) gets a fresh
    // warn even inside the cooldown window.
    const t0 = Date.parse('2026-04-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    createTask({
      id: 'dormant-vanish',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'will be deleted',
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
      context_mode: 'group',
      next_run: new Date(t0 + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    updateTaskAfterRun(
      'dormant-vanish',
      new Date(t0 + 60_000).toISOString(),
      'ok',
    );
    vi.setSystemTime(t0 + DORMANT_CRON_THRESHOLD_MS + 60 * 60_000);

    const warnSpy = vi.spyOn(logger, 'warn');

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask: vi.fn(), closeStdin: vi.fn() } as never,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    await vi.advanceTimersByTimeAsync(10);

    const matches = () =>
      warnSpy.mock.calls.filter(
        (call) =>
          typeof call[1] === 'string' &&
          call[1].startsWith('Dormant recurring task') &&
          (call[0] as { taskId: string }).taskId === 'dormant-vanish',
      ).length;

    expect(matches()).toBe(1);

    // Delete the task and run another prune cycle — this triggers the
    // stale-id cleanup path inside the dormant-warn loop.
    deleteTask('dormant-vanish');
    await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS + 10);
    expect(matches()).toBe(1);

    // Re-create the task with the same id, still inside the original
    // cooldown window. If the map entry was correctly pruned the new
    // dormant task warns; if the map leaked, this would stay at 1.
    //
    // updateTaskAfterRun stamps `last_run = Date.now()` unconditionally,
    // so to seed a dormant `last_run` we briefly roll the system clock
    // back to `t0`, call updateTaskAfterRun (which records that as
    // last_run), then restore the clock to where the prune-cycle test
    // expects it. The 2nd argument is `nextRun`, not last_run.
    const restoreTime = Date.now();
    createTask({
      id: 'dormant-vanish',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'reborn',
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
      context_mode: 'group',
      next_run: new Date(restoreTime + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    vi.setSystemTime(t0);
    updateTaskAfterRun(
      'dormant-vanish',
      new Date(restoreTime + 60_000).toISOString(),
      'ok',
    );
    vi.setSystemTime(restoreTime);
    await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS + 10);
    expect(matches()).toBe(2);

    warnSpy.mockRestore();
  });
  it('pre-advance clears next_run AND sets completed atomically for once-tasks', async () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'once-preadvance',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'fire and never complete',
      schedule_type: 'once',
      schedule_value: pastTime,
      context_mode: 'isolated',
      next_run: pastTime,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (
        _groupJid: string,
        _taskId: string,
        _sessionName: string,
        _fn: () => Promise<void>,
      ) => {
        // Intentionally never invoke _fn — simulates a stuck queue.
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'main@g.us': {
          name: 'Main',
          folder: 'main',
          trigger: 'always',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask, closeStdin: vi.fn() } as never,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('once-preadvance');
    expect(task?.status).toBe('completed');
    expect(task?.next_run).toBeNull();
  });

});
