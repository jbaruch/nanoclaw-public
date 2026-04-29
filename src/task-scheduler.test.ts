import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock container-runner BEFORE importing task-scheduler so the scheduler
// picks up the mocked `runContainerAgent`. We can't actually spawn a
// container in a unit test, so this fake calls the streaming callback
// with whatever output the test-under-test wants to simulate.
//
// `vi.hoisted` is required because `vi.mock(...)` itself is hoisted to
// the top of the file — a plain top-level `const` would be accessed
// before initialisation inside the factory.
const { mockRunContainerAgent, mockStopContainer } = vi.hoisted(() => ({
  mockRunContainerAgent: vi.fn(),
  mockStopContainer: vi.fn(),
}));
vi.mock('./container-runner.js', () => ({
  runContainerAgent: mockRunContainerAgent,
  writeTasksSnapshot: vi.fn(),
  DEFAULT_SESSION_NAME: 'default',
}));
vi.mock('./container-runtime.js', () => ({
  stopContainer: mockStopContainer,
}));

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getSession,
  getTaskById,
  getTaskRunLogs,
  pruneCompletedTasks,
  resurrectZombieTasks,
  setSession,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import {
  COMPLETED_TASK_TTL_MS,
  DORMANT_CRON_THRESHOLD_MS,
  DORMANT_WARN_COOLDOWN_MS,
  PRUNE_INTERVAL_MS,
  TASK_RUN_TIMEOUT_MS,
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
    mockStopContainer.mockClear();
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

  it('maintenance task with context_mode=group does NOT pass prior sessionId but DOES persist newSessionId (issue #10 fix)', async () => {
    // Pre-fix: the scheduler passed the stored maintenance sessionId to
    // runContainerAgent, which caused the SDK to replay the prior turn's
    // final response as the first streamed chunk — captured as the new
    // task's result and written to last_result (cross-attribution bug).
    //
    // Post-fix: sessionId is NEVER passed to the container (always fresh
    // start). The newSessionId returned by the container IS still stored so
    // the per-session .claude/ transcript chain continues to grow on disk.
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };

    // Seed a prior maintenance sessionId — post-fix it must NOT be passed.
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

    expect(mockRunContainerAgent).toHaveBeenCalled();
    const containerInput = mockRunContainerAgent.mock.calls[0][1];

    // sessionId MUST NOT be passed — issue #10 fix. Passing it causes the SDK
    // to replay the prior turn's result as the current task's output.
    expect(containerInput.sessionId).toBeUndefined();
    expect(containerInput.sessionName).toBe(MAINTENANCE_SESSION_NAME);

    // The newSessionId from the streaming callback IS still persisted to the
    // MAINTENANCE slot (not default) — the transcript chain keeps growing.
    expect(getSession('main', MAINTENANCE_SESSION_NAME)).toBe(
      'new-maint-session',
    );
    expect(getSession('main', 'default')).toBeUndefined();
  });

  // --- continuation_cycle_id flow-through ---
  //
  // The scheduler is the bridge between the DB row and the spawned
  // container: when a task row's continuation_cycle_id column is
  // non-NULL, the value must reach the ContainerInput so
  // container-runner can emit the matching env vars. Round-tripping
  // through the scheduler is the load-bearing wiring step — without
  // it, a chained continuation row created by a continuation-aware
  // helper would still spawn a container indistinguishable from a
  // fresh user invocation.

  it('passes continuation_cycle_id from task row through to ContainerInput', async () => {
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-04-21T00:00:00.000Z',
      isMain: true,
    };

    createTask({
      id: 'continuation-task',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: '[CONTINUATION 2026-04-21 #1] Continue chain ...',
      schedule_type: 'once',
      schedule_value: '2026-04-21T00:00:30.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-04-21T00:00:00.000Z',
      continuation_cycle_id: '2026-04-21',
    });

    mockRunContainerAgent.mockImplementation(
      async (_group, _input, _onProc, onOutput) => {
        await onOutput({
          status: 'success',
          result: 'ok',
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

    expect(mockRunContainerAgent).toHaveBeenCalled();
    const containerInput = mockRunContainerAgent.mock.calls[0][1];
    expect(containerInput.continuationCycleId).toBe('2026-04-21');
  });

  it('omits continuationCycleId on ordinary tasks (no continuation env vars)', async () => {
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-04-21T00:00:00.000Z',
      isMain: true,
    };

    createTask({
      id: 'plain-task',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'plain scheduled task',
      schedule_type: 'once',
      schedule_value: '2026-04-21T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-04-21T00:00:00.000Z',
      // continuation_cycle_id intentionally omitted — DB stores NULL.
    });

    mockRunContainerAgent.mockImplementation(
      async (_group, _input, _onProc, onOutput) => {
        await onOutput({
          status: 'success',
          result: 'ok',
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

    const containerInput = mockRunContainerAgent.mock.calls[0][1];
    // Must be undefined (not null) — the ContainerInput field is
    // typed as optional string and the container-runner uses a
    // truthiness check that treats `null` the same, but downstream
    // consumers (logging, future code) would observe the wrong
    // shape if the scheduler forwarded SQL NULL verbatim.
    expect(containerInput.continuationCycleId).toBeUndefined();
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
    // when count > 0. Seed two expired completed once-tasks; the first
    // gated call removes both in a single transaction (count=2, one log
    // line). To get a SECOND log line we then seed another expired row
    // and cross the PRUNE_INTERVAL_MS boundary.
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
      // Stamp last_run in the past so resurrectZombieTasks() at startup
      // skips this row (its predicate requires last_run IS NULL). The
      // COALESCE(last_run, created_at) prune predicate still matches via
      // the past last_run, preserving the test's prune-throttle intent.
      vi.setSystemTime(t0 - COMPLETED_TASK_TTL_MS - 60_000);
      updateTaskAfterRun(id, null, 'ok');
    }
    vi.setSystemTime(t0);

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
    // 30 ticks at 60s stride covered ~30 minutes of mocked time, well
    // under PRUNE_INTERVAL_MS (1h). The throttle means only the very
    // first tick (lastPruneAt=0) passes the gate → exactly one
    // "Pruned" log line, even though both seeded rows are eligible.
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
    // See comment above on p1/p2: past last_run keeps resurrect away
    // while still letting prune match via COALESCE(last_run, created_at).
    vi.setSystemTime(tNow - COMPLETED_TASK_TTL_MS - 60_000);
    updateTaskAfterRun('p3', null, 'ok');
    vi.setSystemTime(tNow);

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

  it('freshly-created recurring task with NULL last_run is NOT flagged dormant', async () => {
    // A cron created moments ago — last_run is NULL because it simply
    // hasn't been due yet, not because dispatch is broken. The dormant
    // scan should NOT warn until the task's age (created_at) crosses
    // DORMANT_CRON_THRESHOLD_MS. Pre-fix, the SQL used
    // `last_run IS NULL OR last_run < ?` which matched any NULL row
    // regardless of age and produced a false positive on the very first
    // scheduler tick.
    const t0 = Date.parse('2026-04-01T00:00:00.000Z');
    vi.setSystemTime(t0);

    createTask({
      id: 'fresh-cron',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'morning brief',
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
      context_mode: 'group',
      next_run: new Date(t0 + 60_000).toISOString(),
      status: 'active',
      // created_at = "now" — fresh task, well within DORMANT_CRON_THRESHOLD_MS.
      created_at: new Date(t0).toISOString(),
    });
    // Deliberately do NOT call updateTaskAfterRun — last_run stays NULL,
    // mirroring a never-run cron.

    const warnSpy = vi.spyOn(logger, 'warn');

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask: vi.fn(), closeStdin: vi.fn() } as never,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    // First tick passes the prune gate (lastPruneAt=0). The dormant
    // sweep runs; with the COALESCE fix it must NOT flag this task.
    await vi.advanceTimersByTimeAsync(10);

    const dormantWarns = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === 'string' &&
        call[1].startsWith('Dormant recurring task') &&
        (call[0] as { taskId: string }).taskId === 'fresh-cron',
    );
    expect(dormantWarns.length).toBe(0);

    // Sanity check: once the row's `created_at` is older than the
    // dormancy threshold, it DOES qualify — confirming the fix didn't
    // accidentally exclude all NULL-last_run rows. Roll the clock past
    // the threshold and re-open the prune gate.
    vi.setSystemTime(t0 + DORMANT_CRON_THRESHOLD_MS + 60 * 60_000);
    await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS + 10);
    const dormantWarnsAfter = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === 'string' &&
        call[1].startsWith('Dormant recurring task') &&
        (call[0] as { taskId: string }).taskId === 'fresh-cron',
    );
    expect(dormantWarnsAfter.length).toBe(1);

    warnSpy.mockRestore();
  });

  it('resurrectZombieTasks flips pre-advanced once-tasks back to active so getDueTasks can pick them up', () => {
    // Pre-advance shape: status='completed', last_run=NULL, next_run set,
    // schedule_type='once'. This is what the scheduler writes between the
    // pre-advance UPDATE and the queue.enqueueTask call. If dispatch is
    // dropped (host crash, queue shut down mid-tick), the row sits here
    // forever — pruneCompletedTasks would eventually GC it but the
    // schedule is lost. resurrect puts it back in front of the loop.
    // next_run must be in the future relative to wall clock: resurrect
    // only revives tasks whose schedule hasn't already lapsed (the
    // `next_run > datetime('now')` gate in `resurrectZombieTasks`),
    // since stale-past tasks are intent-expired. Use a far-future
    // sentinel so the fixture stays valid across calendar drift.
    createTask({
      id: 'zombie-once',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'should have run',
      schedule_type: 'once',
      schedule_value: '2099-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2099-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    // Reproduce the pre-advance write without the matching updateTaskAfterRun.
    updateTask('zombie-once', { status: 'completed' });
    expect(getTaskById('zombie-once')?.status).toBe('completed');
    expect(getTaskById('zombie-once')?.last_run ?? null).toBeNull();

    const resurrected = resurrectZombieTasks();
    expect(resurrected).toEqual(['zombie-once']);
    expect(getTaskById('zombie-once')?.status).toBe('active');
    expect(getTaskById('zombie-once')?.next_run).toBe(
      '2099-01-01T00:00:00.000Z',
    );
  });

  it('resurrectZombieTasks leaves genuinely-completed once-tasks alone (last_run is set)', () => {
    // A task that ran successfully has both last_run set and status='completed'
    // (updateTaskAfterRun stamps both). The resurrect query specifically
    // requires last_run IS NULL, so this row must NOT be resurrected.
    createTask({
      id: 'ran-properly',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'ran ok',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    // updateTaskAfterRun: stamps last_run AND flips to completed for once-tasks.
    updateTaskAfterRun('ran-properly', null, 'ok');
    expect(getTaskById('ran-properly')?.status).toBe('completed');
    expect(getTaskById('ran-properly')?.last_run).toBeTruthy();

    const resurrected = resurrectZombieTasks();
    expect(resurrected).toEqual([]);
    expect(getTaskById('ran-properly')?.status).toBe('completed');
  });

  it('resurrectZombieTasks ignores recurring tasks even if they somehow reach status=completed', () => {
    // computeNextRun never returns null for cron/interval tasks, so they
    // can't legitimately reach status='completed' through the scheduler.
    // The schedule_type='once' clause is defensive — verify it holds even
    // if a recurring row is force-set to completed via direct updateTask
    // (e.g. operator action, db migration mishap).
    createTask({
      id: 'cron-frozen',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'daily',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'group',
      next_run: '2026-01-02T17:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    updateTask('cron-frozen', { status: 'completed' });

    const resurrected = resurrectZombieTasks();
    expect(resurrected).toEqual([]);
    // Recurring row stays where the operator put it.
    expect(getTaskById('cron-frozen')?.status).toBe('completed');
  });

  // --- Issue #10: last_result cross-attribution fix ---
  //
  // When a context_mode='group' task resumes a prior SDK session the SDK
  // replays the prior turn's final response as the first streamed chunk —
  // the agent-runner converts that to an OUTPUT_START/END marker, which
  // runTask's streaming callback captured as the *new* task's result and
  // wrote to last_result. Fix: never pass sessionId to the container for
  // scheduled tasks (always start fresh). The newSessionId returned by the
  // container is still stored so the per-session .claude/ transcript chain
  // grows, but we don't pass the id to query().

  it('scheduled task does not pass sessionId to container even for context_mode=group (cross-attribution fix)', async () => {
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };

    // Seed a prior maintenance sessionId — the pre-fix code would have passed
    // this to runContainerAgent, causing the SDK to replay the prior turn.
    setSession(
      'main',
      MAINTENANCE_SESSION_NAME,
      'prior-session-must-not-be-used',
    );

    createTask({
      id: 'no-resume-task',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'run fresh',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    mockRunContainerAgent.mockImplementation(
      async (_group, _input, _onProc, onOutput) => {
        await onOutput({
          status: 'success',
          result: 'fresh-result',
          newSessionId: 'new-session-from-run',
        } as ContainerOutput);
        return { status: 'success', result: 'fresh-result' };
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
      getSessions: () => ({
        main: { maintenance: 'prior-session-must-not-be-used' },
      }),
      queue: { enqueueTask, closeStdin: vi.fn() } as never,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(mockRunContainerAgent).toHaveBeenCalled();
    const containerInput = mockRunContainerAgent.mock.calls[0][1];

    // The prior sessionId MUST NOT be passed — doing so triggers SDK replay
    // of the previous turn's result, causing cross-attribution (issue #10).
    expect(containerInput.sessionId).toBeUndefined();

    // The newSessionId returned by the container IS still stored so the
    // per-session transcript chain continues to grow.
    expect(getSession('main', MAINTENANCE_SESSION_NAME)).toBe(
      'new-session-from-run',
    );
  });

  it('two sequential context_mode=group tasks get isolated last_result values (no cross-attribution)', async () => {
    // Regression test for issue #10: task B must never see task A's result
    // in its own last_result row, even when they share the same group and
    // maintenance session slot.
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };

    const now = Date.now();

    createTask({
      id: 'task-A',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'task A prompt',
      schedule_type: 'interval',
      schedule_value: '120000',
      context_mode: 'group',
      next_run: new Date(now - 2000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    createTask({
      id: 'task-B',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'task B prompt',
      schedule_type: 'interval',
      schedule_value: '120000',
      context_mode: 'group',
      next_run: new Date(now - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    // Each task returns its own distinctively-labelled result.
    mockRunContainerAgent
      .mockImplementationOnce(async (_group, _input, _onProc, onOutput) => {
        await onOutput!({
          status: 'success',
          result: 'MARKER_FROM_TASK_A',
        } as ContainerOutput);
        return { status: 'success', result: 'MARKER_FROM_TASK_A' };
      })
      .mockImplementationOnce(async (_group, _input, _onProc, onOutput) => {
        await onOutput!({
          status: 'success',
          result: 'MARKER_FROM_TASK_B',
        } as ContainerOutput);
        return { status: 'success', result: 'MARKER_FROM_TASK_B' };
      });

    // Run tasks synchronously in order to avoid concurrency noise.
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

    const taskA = getTaskById('task-A');
    const taskB = getTaskById('task-B');

    // Task A's last_result must only contain A's marker.
    expect(taskA?.last_result).toContain('MARKER_FROM_TASK_A');
    expect(taskA?.last_result).not.toContain('MARKER_FROM_TASK_B');

    // Task B's last_result must only contain B's marker (cross-attribution fix).
    expect(taskB?.last_result).toContain('MARKER_FROM_TASK_B');
    expect(taskB?.last_result).not.toContain('MARKER_FROM_TASK_A');
  });

  // --- Issue #17: atomic log + update invariant ---
  //
  // Every successful or failed task run MUST produce BOTH a task_run_logs
  // row AND update scheduled_tasks.last_run in the same transaction. The
  // pre-fix code called logTaskRun() and updateTaskAfterRun() separately,
  // so a crash or DB error between the two calls left the task in an
  // inconsistent state: last_run set but no run-log (or vice versa).
  //
  // logAndUpdateTask() wraps both in a single SQLite transaction. The tests
  // below verify that after a task run, both the log row and the scheduled_tasks
  // update are present and consistent.

  it('after a successful task run, task_run_logs row and scheduled_tasks.last_run are both set (issue #17 invariant)', async () => {
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };

    createTask({
      id: 'atomic-once-task',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'run once',
      schedule_type: 'once',
      schedule_value: '2026-01-01T12:00:00Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    mockRunContainerAgent.mockImplementation(
      async (_group, _input, _onProc, onOutput) => {
        await onOutput!({
          status: 'success',
          result: 'task-output',
        } as ContainerOutput);
        return { status: 'success', result: 'task-output' };
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

    const task = getTaskById('atomic-once-task');
    const logs = getTaskRunLogs('atomic-once-task');

    // The run-log row MUST exist — pre-fix, this was the missing piece.
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('success');

    // scheduled_tasks.last_run must be set and match the run-log's run_at
    // exactly (they share the same clock reading from the transaction).
    expect(task?.last_run).toBeTruthy();
    expect(task?.last_run).toBe(logs[0].run_at);

    // last_result must reflect the actual output, not be NULL.
    expect(task?.last_result).toContain('task-output');

    // status=completed for a once-task.
    expect(task?.status).toBe('completed');
  });

  it('after a failed task run, task_run_logs row and scheduled_tasks.last_run are both set (error path)', async () => {
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };

    createTask({
      id: 'atomic-error-task',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'run and fail',
      schedule_type: 'once',
      schedule_value: '2026-01-01T12:00:00Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    // Simulate container failure
    mockRunContainerAgent.mockImplementation(
      async (_group, _input, _onProc, onOutput) => {
        await onOutput!({
          status: 'error',
          result: null,
          error: 'container-crash',
        } as ContainerOutput);
        return { status: 'error', result: null, error: 'container-crash' };
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

    const task = getTaskById('atomic-error-task');
    const logs = getTaskRunLogs('atomic-error-task');

    // Error path: log row must also exist.
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('error');

    // last_run must be set and consistent with run_at.
    expect(task?.last_run).toBeTruthy();
    expect(task?.last_run).toBe(logs[0].run_at);

    // last_result contains the error prefix.
    expect(task?.last_result).toMatch(/^Error:/);
  });

  it('task_run_logs.run_at and scheduled_tasks.last_run share the same timestamp (no synthetic schedule-time bleed)', async () => {
    // Regression guard for the specific symptom in #17: last_run was set to
    // the schedule_value time (round .000Z ms) rather than wall-clock time.
    // logAndUpdateTask uses a single `now = new Date().toISOString()` for
    // both fields, so they always agree and are never synthetic.
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };

    const scheduleValue = '2026-01-01T09:33:24'; // local-time ISO without Z, no ms
    const scheduleValueAsUtc = new Date(scheduleValue).toISOString(); // .000Z on PDT

    createTask({
      id: 'no-synthetic-ts-task',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'check timestamps',
      schedule_type: 'once',
      schedule_value: scheduleValue,
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    mockRunContainerAgent.mockImplementation(
      async (_group, _input, _onProc, onOutput) => {
        await onOutput!({ status: 'success', result: 'ok' } as ContainerOutput);
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

    const task = getTaskById('no-synthetic-ts-task');
    const logs = getTaskRunLogs('no-synthetic-ts-task');

    expect(logs).toHaveLength(1);
    // last_run must equal run_at — they come from the same `now` in the tx.
    expect(task?.last_run).toBe(logs[0].run_at);
    // Neither must equal the .000Z synthetic schedule-value UTC conversion.
    // (This test may pass coincidentally if the wall clock happens to
    // produce .000Z at the exact ms boundary, but that's a false pass
    // only if the test machine is extraordinarily unlucky and the
    // schedule_value UTC conversion also matches — negligible probability.)
    expect(task?.last_run).not.toBe(scheduleValueAsUtc);
  });

  // --- Gate-script failure reclassification (#26 / Fix B) ---
  //
  // Heartbeats and other script-gated tasks run a precheck script
  // before waking the agent. When the script (or its underlying
  // `check-unanswered.py`) hits a hard failure — e.g. the untrusted
  // container losing read access to `/workspace/store/messages.db` —
  // the agent dutifully wraps the failure note in `<internal>` tags
  // and the container still reports `status: 'success'`. Pre-fix:
  // every such run wrote `task_run_logs.status = 'success'`, hiding
  // 96 wasted wake-ups/day on `heartbeat-telegram_old-wtf` and lying
  // to "show me broken tasks" queries. Post-fix: the orchestrator
  // pattern-matches stable failure markers in the result payload and
  // reclassifies as `'error'` before the row is written.

  it('reclassifies a script-gate-fails run as error when the result contains a DB-access-failure marker (#26 Fix B)', async () => {
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };

    createTask({
      id: 'heartbeat-untrusted-fail',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'heartbeat',
      script: 'echo \'{"wakeAgent":true,"data":{"error":"DB access failed"}}\'',
      schedule_type: 'interval',
      schedule_value: '900000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    // Simulate the production failure mode: the container reports
    // `status: 'success'` even though the gate script's payload tells
    // the agent the DB couldn't be opened. The agent's reasoning
    // arrives wrapped in `<internal>` tags so the user-visible
    // cleanResult is empty — but the raw result still carries the
    // marker the orchestrator must key on.
    mockRunContainerAgent.mockImplementation(
      async (_group, _input, _onProc, onOutput) => {
        const failingResult =
          '<internal>DB access failed — unable to open /workspace/store/messages.db. Unanswered list is empty as a result.</internal>';
        await onOutput!({
          status: 'success',
          result: failingResult,
        } as ContainerOutput);
        return { status: 'success', result: failingResult };
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

    const logs = getTaskRunLogs('heartbeat-untrusted-fail');
    expect(logs).toHaveLength(1);
    // The headline assertion: pre-fix this was 'success'.
    expect(logs[0].status).toBe('error');
    // Forensics preserved — raw result still in the row, not nulled.
    expect(logs[0].result).toContain('DB access failed');
    // last_result reflects the reclassification so a "broken tasks"
    // query keying on `Error:` prefix matches.
    const task = getTaskById('heartbeat-untrusted-fail');
    expect(task?.last_result).toMatch(/^Error:/);
  });

  it('reclassifies on `unable to open` and `env-warning:` markers too (broader-marker coverage)', async () => {
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };

    // Two due tasks, two distinct marker phrases — each must reclassify.
    // Prompts double as routing keys for the mock's per-task payload.
    createTask({
      id: 'marker-unable-to-open',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'unable',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 2000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'marker-env-warning',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'envwarn',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const resultByPrompt: Record<string, string> = {
      unable:
        '<internal>sqlite3.OperationalError: unable to open database file</internal>',
      envwarn:
        '<internal>env-warning: NANOCLAW_DB=/bad path; using default</internal>',
    };

    mockRunContainerAgent.mockImplementation(
      async (_group, input, _onProc, onOutput) => {
        const out = resultByPrompt[input.prompt as string];
        await onOutput!({
          status: 'success',
          result: out,
        } as ContainerOutput);
        return { status: 'success', result: out };
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

    for (const id of ['marker-unable-to-open', 'marker-env-warning']) {
      const logs = getTaskRunLogs(id);
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe('error');
    }
  });

  it('does NOT reclassify a clean success run (negative case)', async () => {
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    };

    createTask({
      id: 'clean-success-task',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'check',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    mockRunContainerAgent.mockImplementation(
      async (_group, _input, _onProc, onOutput) => {
        await onOutput!({
          status: 'success',
          result: '<internal>All quiet, nothing to do.</internal>',
        } as ContainerOutput);
        return {
          status: 'success',
          result: '<internal>All quiet, nothing to do.</internal>',
        };
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

    const logs = getTaskRunLogs('clean-success-task');
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('success');
  });

  // --- Per-task watchdog (#30 Part C) ---

  it('kills container and records status=timeout when runTask exceeds TASK_RUN_TIMEOUT_MS', async () => {
    const MAIN_GROUP = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: '2099-01-01T00:00:00.000Z',
      isMain: true,
    };

    createTask({
      id: 'hanging-task',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'hangs forever',
      schedule_type: 'once',
      schedule_value: '2099-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2099-01-01T00:00:00.000Z',
    });

    // The mock invokes onProcess so the watchdog captures the container
    // name, then returns a never-resolving promise — pre-fix this would
    // wedge `runTask` indefinitely; post-fix the watchdog kills it.
    mockRunContainerAgent.mockImplementation(async (_group, _input, onProc) => {
      onProc({} as never, 'nanoclaw-main-maintenance-test-container');
      return new Promise(() => {
        /* never resolves */
      });
    });

    const enqueueTask = vi.fn(
      (
        _groupJid: string,
        _taskId: string,
        _sessionName: string,
        fn: () => Promise<void>,
      ) => {
        // Don't await — the runTask promise will never resolve naturally
        // until the watchdog fires, but `fn()` returns immediately at
        // the watchdog timeout because the watchdog sets `error` and
        // the catch path completes synchronously with the rejection.
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

    // Advance past the watchdog threshold.
    await vi.advanceTimersByTimeAsync(TASK_RUN_TIMEOUT_MS + 1000);

    // Watchdog must have called stopContainer with the captured name.
    expect(mockStopContainer).toHaveBeenCalledWith(
      'nanoclaw-main-maintenance-test-container',
    );

    // task_run_logs row must record status='timeout' with the
    // 'task watchdog: killed container' marker in the error.
    const logs = getTaskRunLogs('hanging-task');
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe('timeout');
    expect(logs[0].error).toMatch(/task watchdog: killed container/);
    expect(logs[0].duration_ms).toBeGreaterThanOrEqual(TASK_RUN_TIMEOUT_MS);

    // The scheduled_tasks row's last_run must be set so resurrect
    // doesn't re-fire the timed-out task on the next loop.
    const finalTask = getTaskById('hanging-task');
    expect(finalTask?.last_run).toBeTruthy();
    // Once-task → status flips to 'completed' since computeNextRun
    // returns null (logAndUpdateTask CASE).
    expect(finalTask?.status).toBe('completed');
  });
});
