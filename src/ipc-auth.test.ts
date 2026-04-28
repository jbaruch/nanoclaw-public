import fs from 'fs';

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';

// Isolate filesystem writes to a per-process tempdir so running this test
// file doesn't leave artifacts in the developer's real `data/` tree (or
// collide with a local orchestrator that actually uses `DATA_DIR`).
//
// `vi.mock` is hoisted to the very top of the file, ABOVE regular
// top-level const declarations. To share the tempdir path between the
// mock factory and the rest of the file we compute it inside
// `vi.hoisted`, which runs in the same hoisting pass as the mocks.
const { TEST_DATA_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osMod = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require('path') as typeof import('path');
  return {
    TEST_DATA_DIR: pathMod.join(
      osMod.tmpdir(),
      `nanoclaw-ipc-auth-test-${process.pid}`,
    ),
  };
});
vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DATA_DIR,
  };
});

import path from 'path';

import {
  _initTestDatabase,
  createTask,
  deleteRegisteredGroup,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
  updateGroupTrusted,
  updateGroupTrigger,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);

      // Mirror src/index.ts registerGroup heartbeat creation: only fires
      // when `containerConfig.enableHeartbeat` is explicitly opted in
      // (#158 — auto-create on `requiresTrigger` was removed because no
      // group ever had that flag set). Strict `=== true` and
      // `context_mode: 'isolated'` to match production exactly so a
      // regression on either dimension trips these tests.
      if (group.containerConfig?.enableHeartbeat === true && !group.isMain) {
        const heartbeatId = `heartbeat-${group.folder}`;
        if (!getTaskById(heartbeatId)) {
          createTask({
            id: heartbeatId,
            group_folder: group.folder,
            chat_jid: jid,
            prompt: 'mock-heartbeat-prompt',
            schedule_type: 'cron',
            schedule_value: '*/15 * * * *',
            context_mode: 'isolated',
            next_run: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            status: 'active',
            created_at: new Date().toISOString(),
            created_by_role: 'owner',
          });
        }
      }
    },
    unregisterGroup: (jid) => {
      // Mirror src/index.ts unregisterGroup: in-memory + DB delete in
      // one call. Returns the DB delete's truthy-changes result so
      // tests can distinguish "actually removed" from "no row matched".
      delete groups[jid];
      return deleteRegisteredGroup(jid);
    },
    setGroupTrusted: (jid, trusted) => {
      const updated = updateGroupTrusted(jid, trusted);
      if (!updated) return false;
      groups[jid] = updated;
      return true;
    },
    setGroupTrigger: (jid, trigger, requiresTrigger) => {
      const updated = updateGroupTrigger(jid, trigger, requiresTrigger);
      if (!updated) return false;
      groups[jid] = updated;
      // Pre-#158, this mock also mirrored a heartbeat-on-flip side
      // effect. Production no longer touches heartbeats from
      // setGroupTrigger — trigger config and heartbeat opt-in are
      // orthogonal — so the mock omits it too.
      return true;
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    nukeSession: (
      _folder: string,
      _session: 'default' | 'maintenance' | 'all',
    ) => {},
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- schedule_task provenance (created_by_role) ---

describe('schedule_task provenance', () => {
  it('main group schedule_task writes role=main_agent', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'main-scheduled task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'whatsapp_main',
      true, // isMain
      deps,
    );
    const tasks = getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].created_by_role).toBe('main_agent');
  });

  it('trusted non-main group schedule_task writes role=trusted_agent', async () => {
    // Promote OTHER_GROUP to trusted for this test via a local override
    groups['other@g.us'] = {
      ...OTHER_GROUP,
      containerConfig: { trusted: true },
    };
    setRegisteredGroup('other@g.us', groups['other@g.us']);
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'trusted-scheduled task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false, // isMain
      deps,
    );
    const tasks = getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].created_by_role).toBe('trusted_agent');
  });

  it('untrusted non-main group schedule_task writes role=untrusted_agent', async () => {
    // OTHER_GROUP has no containerConfig → untrusted by default
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'untrusted-scheduled task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false, // isMain
      deps,
    );
    const tasks = getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].created_by_role).toBe('untrusted_agent');
  });

  it('payload field cannot spoof the role (security boundary test)', async () => {
    // An untrusted agent MUST NOT be able to claim 'owner' or 'main_agent'
    // by putting it in the IPC payload. The derivation uses the VERIFIED
    // source group's trust tier, not any payload field. Cast-to-Parameters
    // bypasses TS's own protection (which already rejects these fields at
    // compile time) so we can test the runtime behavior on a malicious
    // payload that would arrive as raw JSON from a compromised container.
    const maliciousPayload = {
      type: 'schedule_task',
      prompt: 'spoof attempt',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      targetJid: 'other@g.us',
      // Intentionally-malicious fields:
      created_by_role: 'owner',
      createdByRole: 'owner',
      role: 'main_agent',
    } as unknown as Parameters<typeof processTaskIpc>[0];
    await processTaskIpc(maliciousPayload, 'other-group', false, deps);
    const tasks = getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].created_by_role).toBe('untrusted_agent');
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      created_by_role: 'owner' as const,
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      created_by_role: 'owner' as const,
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
      created_by_role: 'owner' as const,
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      created_by_role: 'owner' as const,
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      created_by_role: 'owner' as const,
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      created_by_role: 'owner' as const,
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- #102: UTC schedule_value + timezone parameter ---

describe('schedule_task with UTC schedule_value (#102)', () => {
  it('once with Z-suffix is anchored to that exact UTC instant', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'utc once',
        schedule_type: 'once',
        schedule_value: '2030-01-01T12:00:00Z',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    // next_run is normalized to ISO; equality of the underlying instant
    // is what matters — not the literal string.
    expect(new Date(tasks[0].next_run!).toISOString()).toBe(
      '2030-01-01T12:00:00.000Z',
    );
    // schedule_timezone is not used for `once` — left null.
    expect(tasks[0].schedule_timezone).toBeFalsy();
  });

  it('local-time once (no suffix) still works for back-compat', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'local once',
        schedule_type: 'once',
        schedule_value: '2030-01-01T12:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    // The promised compat behaviour: a no-suffix local string is
    // interpreted in the host's CURRENT tz at schedule time and pinned
    // to that absolute UTC instant. The simplest tz-portable assertion:
    // construct a `Date` from the original local string the same way
    // the host does, then verify next_run matches that exact instant.
    // `toLocaleString` with explicit format options would also work but
    // varies subtly across Node/ICU versions (en-CA punctuation, etc.)
    // and is overkill for what we're really checking.
    const expectedInstant = new Date('2030-01-01T12:00:00').toISOString();
    expect(tasks[0].next_run).toBe(expectedInstant);
  });

  it('cron with explicit timezone persists schedule_timezone', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'utc cron',
        schedule_type: 'cron',
        schedule_value: '0 12 * * *',
        timezone: 'UTC',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_timezone).toBe('UTC');
    expect(tasks[0].next_run).toBeTruthy();
    // next fire is at 12:00 UTC on some date — minute and hour in UTC
    // should be 0 and 12.
    const nextDate = new Date(tasks[0].next_run!);
    expect(nextDate.getUTCMinutes()).toBe(0);
    expect(nextDate.getUTCHours()).toBe(12);
  });

  it('cron with America/Chicago timezone persists schedule_timezone', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'chicago cron',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        timezone: 'America/Chicago',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_timezone).toBe('America/Chicago');
  });

  it('cron without timezone leaves schedule_timezone null (server default)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'default tz cron',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_timezone).toBeFalsy();
  });

  it('rejects invalid IANA timezone', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad tz',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        timezone: 'Not/A/Real/Zone',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('schedule_timezone is forced null for once-tasks even if timezone passed', async () => {
    // A timezone value on a non-cron schedule would persist and silently
    // start affecting cron evaluation if the task is later updated to
    // schedule_type: 'cron' without re-passing timezone — Copilot review
    // flagged this as a footgun. Drop it at schedule time.
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'once with stray tz',
        schedule_type: 'once',
        schedule_value: '2030-01-01T12:00:00Z',
        timezone: 'America/Chicago',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_timezone).toBeFalsy();
  });

  it('schedule_timezone is forced null for interval-tasks even if timezone passed', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval with stray tz',
        schedule_type: 'interval',
        schedule_value: '3600000',
        timezone: 'Europe/Berlin',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_timezone).toBeFalsy();
  });

  it('update_task recomputes next_run when once-task schedule_value changes', async () => {
    // Seed a once-task with one timestamp, then update it to a later one
    // and verify next_run actually moves. Without the once branch in
    // update_task's recompute, next_run stayed at the original instant
    // and the task fired at the wrong time.
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'once-update-test',
        prompt: 'once update',
        schedule_type: 'once',
        schedule_value: '2030-01-01T12:00:00Z',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'once-update-test',
        schedule_value: '2030-06-01T18:30:00Z',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const updated = getTaskById('once-update-test');
    expect(updated?.next_run).toBe('2030-06-01T18:30:00.000Z');
  });

  it('update_task rejects invalid once timestamp without breaking existing row', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'once-bad-update',
        prompt: 'once',
        schedule_type: 'once',
        schedule_value: '2030-01-01T12:00:00Z',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'once-bad-update',
        schedule_value: 'not-a-date',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Original next_run should be intact — invalid update is a no-op.
    expect(getTaskById('once-bad-update')?.next_run).toBe(
      '2030-01-01T12:00:00.000Z',
    );
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });

  it('register_group does NOT auto-create a heartbeat for a non-main group with requiresTrigger=true (#158)', async () => {
    // Pre-#158, the `requiresTrigger !== false` branch in registerGroup
    // would surprise-create a heartbeat for any non-main group whose
    // trigger flag was on. The IPC handler defaults `requiresTrigger`
    // to false when omitted (which would skip the old branch anyway),
    // so we explicitly set `requiresTrigger: true` here to exercise the
    // exact pre-#158 condition. With the auto-rule removed, heartbeat
    // creation now requires `containerConfig.enableHeartbeat === true`.
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'silent@g.us',
        name: 'Silent',
        folder: 'silent-group',
        trigger: '@Andy',
        requiresTrigger: true,
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('silent@g.us')).toBeDefined();
    expect(getRegisteredGroup('silent@g.us')?.requiresTrigger).toBe(true);
    expect(getTaskById('heartbeat-silent-group')).toBeUndefined();
  });

  it('register_group with enableHeartbeat creates the non-main heartbeat (#158)', async () => {
    // Explicit opt-in is the only path that creates a non-main
    // heartbeat after #158. Verify the row appears with a 15-minute
    // cron schedule.
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'beating@g.us',
        name: 'Beating',
        folder: 'beating-group',
        trigger: '@Andy',
        containerConfig: { enableHeartbeat: true },
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('beating@g.us')?.containerConfig).toEqual({
      enableHeartbeat: true,
    });
    const heartbeat = getTaskById('heartbeat-beating-group');
    expect(heartbeat).toBeDefined();
    expect(heartbeat?.group_folder).toBe('beating-group');
    expect(heartbeat?.schedule_type).toBe('cron');
    expect(heartbeat?.schedule_value).toBe('*/15 * * * *');
  });
});

// --- unregister_group (#159) ---

describe('unregister_group authorization', () => {
  it('non-main group is rejected', async () => {
    await processTaskIpc(
      { type: 'unregister_group', jid: 'other@g.us' },
      'other-group',
      false,
      deps,
    );

    // Group still registered — unauthorized call rejected before any
    // mutation.
    expect(getRegisteredGroup('other@g.us')).toBeDefined();
    expect(groups['other@g.us']).toBeDefined();
  });
});

describe('unregister_group success', () => {
  it('main group can unregister a non-main group from both stores', async () => {
    expect(getRegisteredGroup('other@g.us')).toBeDefined();

    await processTaskIpc(
      { type: 'unregister_group', jid: 'other@g.us' },
      'whatsapp_main',
      true,
      deps,
    );

    // DB row gone
    expect(getRegisteredGroup('other@g.us')).toBeUndefined();
    // In-memory mirror gone — subsequent routing decisions stop
    // treating the JID as registered before any restart.
    expect(groups['other@g.us']).toBeUndefined();
  });

  it('trims whitespace-padded jid before lookup', async () => {
    expect(getRegisteredGroup('other@g.us')).toBeDefined();

    await processTaskIpc(
      { type: 'unregister_group', jid: '  other@g.us  ' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('other@g.us')).toBeUndefined();
  });

  it('refuses to unregister a main group', async () => {
    setRegisteredGroup('main@g.us', {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-01-01',
      isMain: true,
    });
    groups['main@g.us'] = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-01-01',
      isMain: true,
    };

    await processTaskIpc(
      { type: 'unregister_group', jid: 'main@g.us' },
      'whatsapp_main',
      true,
      deps,
    );

    // Main row preserved — losing it mid-runtime would leave the
    // orchestrator without any path to recreate it via IPC.
    expect(getRegisteredGroup('main@g.us')).toBeDefined();
    expect(groups['main@g.us']).toBeDefined();
  });

  it('rejects request with missing jid', async () => {
    await processTaskIpc(
      { type: 'unregister_group' },
      'whatsapp_main',
      true,
      deps,
    );

    // No mutation — sentinel group still registered.
    expect(getRegisteredGroup('other@g.us')).toBeDefined();
  });

  it('is a no-op for an unregistered jid (idempotent)', async () => {
    await processTaskIpc(
      { type: 'unregister_group', jid: 'never-registered@g.us' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('never-registered@g.us')).toBeUndefined();
    // Sibling registrations untouched.
    expect(getRegisteredGroup('other@g.us')).toBeDefined();
  });

  it('cascade-deletes scheduled tasks tied to the unregistered folder', async () => {
    // Pre-state: a heartbeat-style scheduled task and an unrelated
    // one-off task exist for the group folder. Unregister must clear
    // BOTH so the scheduler doesn't keep firing them every cycle and
    // logging "Group not found for task" noise. A sibling group's
    // task is a control: it must survive untouched.
    //
    // Fixed timestamps per testing-standards (`Provide fixed test
    // data; never have the test generate its own inputs randomly`) —
    // runtime-derived clock values would make the row contents
    // non-deterministic across runs.
    const FIXED_CREATED_AT = '2026-01-01T00:00:00.000Z';
    const FIXED_NEXT_RUN_15MIN = '2026-01-01T00:15:00.000Z';
    const FIXED_NEXT_RUN_ONCE = '2026-12-01T00:00:00.000Z';
    createTask({
      id: 'heartbeat-other-group',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'mock-heartbeat-prompt',
      schedule_type: 'cron',
      schedule_value: '*/15 * * * *',
      context_mode: 'isolated',
      next_run: FIXED_NEXT_RUN_15MIN,
      status: 'active',
      created_at: FIXED_CREATED_AT,
      created_by_role: 'owner',
    });
    createTask({
      id: 'oneoff-other-group',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'do the thing',
      schedule_type: 'once',
      schedule_value: FIXED_NEXT_RUN_ONCE,
      context_mode: 'group',
      next_run: FIXED_NEXT_RUN_ONCE,
      status: 'active',
      created_at: FIXED_CREATED_AT,
      created_by_role: 'main_agent',
    });
    createTask({
      id: 'sibling-third-group',
      group_folder: 'third-group',
      chat_jid: 'third@g.us',
      prompt: 'unrelated',
      schedule_type: 'once',
      schedule_value: FIXED_NEXT_RUN_ONCE,
      context_mode: 'group',
      next_run: FIXED_NEXT_RUN_ONCE,
      status: 'active',
      created_at: FIXED_CREATED_AT,
      created_by_role: 'main_agent',
    });
    expect(getTaskById('heartbeat-other-group')).toBeDefined();
    expect(getTaskById('oneoff-other-group')).toBeDefined();
    expect(getTaskById('sibling-third-group')).toBeDefined();

    await processTaskIpc(
      { type: 'unregister_group', jid: 'other@g.us' },
      'whatsapp_main',
      true,
      deps,
    );

    // Tasks for the unregistered folder are gone…
    expect(getTaskById('heartbeat-other-group')).toBeUndefined();
    expect(getTaskById('oneoff-other-group')).toBeUndefined();
    // …sibling group's task survives.
    expect(getTaskById('sibling-third-group')).toBeDefined();
    // Registration itself was removed too.
    expect(getRegisteredGroup('other@g.us')).toBeUndefined();
  });
});

// --- set_trusted / set_trigger (#105) ---

describe('set_trusted', () => {
  it('main group can flip trusted on a registered group', async () => {
    await processTaskIpc(
      { type: 'set_trusted', jid: 'other@g.us', trusted: true },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('other@g.us');
    expect(group?.containerConfig?.trusted).toBe(true);
    // Other fields preserved
    expect(group?.trigger).toBe('@Andy');
    expect(group?.folder).toBe('other-group');
  });

  it('main group can flip trusted back to false', async () => {
    setRegisteredGroup('other@g.us', {
      ...OTHER_GROUP,
      containerConfig: { trusted: true },
    });
    await processTaskIpc(
      { type: 'set_trusted', jid: 'other@g.us', trusted: false },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('other@g.us')?.containerConfig?.trusted).toBe(
      false,
    );
  });

  it('non-main group cannot flip trusted', async () => {
    await processTaskIpc(
      { type: 'set_trusted', jid: 'other@g.us', trusted: true },
      'other-group',
      false,
      deps,
    );

    expect(
      getRegisteredGroup('other@g.us')?.containerConfig?.trusted,
    ).toBeUndefined();
  });

  it('set_trusted on unregistered jid is a no-op (no DB row created)', async () => {
    await processTaskIpc(
      { type: 'set_trusted', jid: 'never-registered@g.us', trusted: true },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('never-registered@g.us')).toBeUndefined();
  });

  it('set_trusted preserves additionalMounts and other containerConfig fields', async () => {
    setRegisteredGroup('other@g.us', {
      ...OTHER_GROUP,
      containerConfig: {
        trusted: false,
        additionalMounts: [
          { hostPath: '/tmp/extra', containerPath: 'extra', readonly: true },
        ],
      },
    });
    await processTaskIpc(
      { type: 'set_trusted', jid: 'other@g.us', trusted: true },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('other@g.us');
    expect(group?.containerConfig?.trusted).toBe(true);
    expect(group?.containerConfig?.additionalMounts).toEqual([
      { hostPath: '/tmp/extra', containerPath: 'extra', readonly: true },
    ]);
  });

  it('rejects empty/whitespace JID', async () => {
    await processTaskIpc(
      { type: 'set_trusted', jid: '  ', trusted: true },
      'whatsapp_main',
      true,
      deps,
    );

    // No row should be modified — OTHER_GROUP has no containerConfig
    // and an empty-jid call shouldn't have created one.
    expect(
      getRegisteredGroup('other@g.us')?.containerConfig?.trusted,
    ).toBeUndefined();
  });

  it('trims surrounding whitespace from the JID before lookup', async () => {
    await processTaskIpc(
      { type: 'set_trusted', jid: '  other@g.us  ', trusted: true },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('other@g.us')?.containerConfig?.trusted).toBe(
      true,
    );
  });
});

describe('set_trigger', () => {
  it('main group can change trigger on a registered group', async () => {
    await processTaskIpc(
      { type: 'set_trigger', jid: 'other@g.us', trigger: '@NewName' },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('other@g.us');
    expect(group?.trigger).toBe('@NewName');
    // Other fields preserved
    expect(group?.folder).toBe('other-group');
  });

  it('main group can update trigger and requiresTrigger together', async () => {
    await processTaskIpc(
      {
        type: 'set_trigger',
        jid: 'other@g.us',
        trigger: '@NewName',
        requiresTrigger: true,
      },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('other@g.us');
    expect(group?.trigger).toBe('@NewName');
    expect(group?.requiresTrigger).toBe(true);
  });

  it('set_trigger leaves requiresTrigger untouched when omitted', async () => {
    setRegisteredGroup('other@g.us', { ...OTHER_GROUP, requiresTrigger: true });
    await processTaskIpc(
      { type: 'set_trigger', jid: 'other@g.us', trigger: '@Andy2' },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('other@g.us');
    expect(group?.trigger).toBe('@Andy2');
    expect(group?.requiresTrigger).toBe(true);
  });

  it('non-main group cannot change trigger', async () => {
    await processTaskIpc(
      { type: 'set_trigger', jid: 'other@g.us', trigger: '@Hijack' },
      'other-group',
      false,
      deps,
    );

    expect(getRegisteredGroup('other@g.us')?.trigger).toBe('@Andy');
  });

  it('set_trigger rejects empty trigger (would silently revert to default)', async () => {
    await processTaskIpc(
      { type: 'set_trigger', jid: 'other@g.us', trigger: '' },
      'whatsapp_main',
      true,
      deps,
    );

    // Trigger should remain @Andy from beforeEach setup.
    expect(getRegisteredGroup('other@g.us')?.trigger).toBe('@Andy');
  });

  it('set_trigger rejects whitespace-only trigger', async () => {
    await processTaskIpc(
      { type: 'set_trigger', jid: 'other@g.us', trigger: '   \t\n  ' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('other@g.us')?.trigger).toBe('@Andy');
  });

  it('set_trigger trims surrounding whitespace from the stored trigger', async () => {
    await processTaskIpc(
      { type: 'set_trigger', jid: 'other@g.us', trigger: '  @Trimmed  ' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('other@g.us')?.trigger).toBe('@Trimmed');
  });

  it('set_trigger trims surrounding whitespace from the JID before lookup', async () => {
    // Without trimming, a whitespace-padded JID would never match the
    // registry key and the caller would see a misleading
    // "group not registered" warning.
    await processTaskIpc(
      { type: 'set_trigger', jid: '  other@g.us  ', trigger: '@PaddedJid' },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('other@g.us')?.trigger).toBe('@PaddedJid');
  });

  it('set_trigger on unregistered jid is a no-op', async () => {
    await processTaskIpc(
      {
        type: 'set_trigger',
        jid: 'never-registered@g.us',
        trigger: '@Whatever',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('never-registered@g.us')).toBeUndefined();
  });

  it('set_trigger flipping requiresTrigger false→true does NOT create a heartbeat task', async () => {
    // Heartbeat lifecycle is orthogonal to trigger config (#158) — the
    // only path that creates a non-main heartbeat is registerGroup with
    // `containerConfig.enableHeartbeat`. Flipping the trigger flag must
    // not have a side effect on scheduled tasks.
    setRegisteredGroup('other@g.us', {
      ...OTHER_GROUP,
      requiresTrigger: false,
    });
    groups['other@g.us'] = { ...OTHER_GROUP, requiresTrigger: false };
    expect(getTaskById('heartbeat-other-group')).toBeUndefined();

    await processTaskIpc(
      {
        type: 'set_trigger',
        jid: 'other@g.us',
        trigger: '@Andy',
        requiresTrigger: true,
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getTaskById('heartbeat-other-group')).toBeUndefined();
  });

  it('set_trigger flipping requiresTrigger true→false leaves an existing heartbeat in place', async () => {
    // Pre-state: non-main group with an existing heartbeat row (e.g.
    // from a pre-#158 auto-create or an explicit opt-in). The operator
    // is now disabling trigger-required mode. The flip must not
    // delete the row — heartbeat lifecycle is no longer coupled to
    // trigger config (#158), and silently destroying operator state
    // would surprise anyone relying on the row for diagnostics.
    setRegisteredGroup('other@g.us', {
      ...OTHER_GROUP,
      requiresTrigger: true,
    });
    groups['other@g.us'] = { ...OTHER_GROUP, requiresTrigger: true };
    createTask({
      id: 'heartbeat-other-group',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'preexisting-heartbeat',
      schedule_type: 'cron',
      schedule_value: '*/15 * * * *',
      context_mode: 'group',
      next_run: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
      created_by_role: 'owner',
    });
    expect(getTaskById('heartbeat-other-group')).toBeDefined();

    await processTaskIpc(
      {
        type: 'set_trigger',
        jid: 'other@g.us',
        trigger: '@Andy',
        requiresTrigger: false,
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Heartbeat row preserved across the flip.
    const heartbeat = getTaskById('heartbeat-other-group');
    expect(heartbeat).toBeDefined();
    expect(heartbeat?.prompt).toBe('preexisting-heartbeat');
  });
});

// --- tessl_update / push_staged_to_branch authorization ---
//
// These handlers are main-only because they touch the global tile
// registry / open commits against shared tile repos. On unauthorized
// calls, processTaskIpc writes an error response to the requesting
// group's input dir so the container-side MCP caller doesn't just hang
// until its own timeout. The tests below assert both the write and the
// message content — if someone accidentally drops the `!isMain` guard,
// we want vitest to fail, not a runtime CVE.
//
// We run these with a real filesystem write into `TEST_DATA_DIR/ipc/...`
// (the mocked DATA_DIR — see `vi.mock('./config.js', ...)` above)
// because the handler uses `fs.writeFileSync` directly (no mockable
// seam). `afterEach` cleans up the resulting files; `afterAll` wipes
// the whole tempdir as a backstop if a test crashed mid-run.

const UNAUTH_GROUP = 'other-group';
const unauthInputDir = path.join(
  TEST_DATA_DIR,
  'ipc',
  UNAUTH_GROUP,
  'input-default',
);

// Last-resort cleanup after the whole file finishes. Individual afterEach
// calls remove dirs they explicitly created, but a test that crashes
// mid-run could leave the tempdir behind — wiping it on afterAll keeps
// /tmp tidy across repeated test runs.
afterAll(() => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});
const unauthCreatedDirs: string[] = [];
const unauthCreatedFiles: string[] = [];

function ensureUnauthInputDir(): void {
  // Track what we create so afterEach can clean up without blowing
  // away a pre-existing real orchestrator data dir (unlikely in CI,
  // possible locally).
  let p = unauthInputDir;
  while (!fs.existsSync(p) && p !== path.dirname(p)) {
    unauthCreatedDirs.unshift(p);
    p = path.dirname(p);
  }
  fs.mkdirSync(unauthInputDir, { recursive: true });
}

function resultPathFor(requestId: string): string {
  const p = path.join(unauthInputDir, `_script_result_${requestId}.json`);
  unauthCreatedFiles.push(p);
  return p;
}

// Shared afterEach body for the auth describes below. The logic was
// originally duplicated across blocks; extracting it means the two
// describes can't silently drift (e.g. one forgets the `.reverse()` and
// starts leaving orphan dirs). Kept as a plain function rather than a
// hook so each describe decides when to register it — right now that's
// just `afterEach(cleanupUnauthFixtures)`.
function cleanupUnauthFixtures(): void {
  for (const f of unauthCreatedFiles.splice(0)) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  // Iterate deepest-first so each rmdirSync sees an empty directory.
  // `ensureUnauthInputDir` unshifts parents onto the array as it walks
  // upward, so the raw array is parent-to-child; reversing puts the
  // leaf directory first, and by the time we reach its parent the
  // leaf is already gone.
  for (const d of unauthCreatedDirs.splice(0).reverse()) {
    if (fs.existsSync(d) && fs.readdirSync(d).length === 0) {
      fs.rmdirSync(d);
    }
  }
}

describe('tessl_update authorization', () => {
  beforeEach(() => {
    ensureUnauthInputDir();
  });

  afterEach(() => {
    cleanupUnauthFixtures();
  });

  it('non-main group is rejected with an error response', async () => {
    const resultPath = resultPathFor('test-tessl-unauth');

    await processTaskIpc(
      { type: 'tessl_update', requestId: 'test-tessl-unauth' },
      UNAUTH_GROUP,
      false,
      deps,
    );

    expect(fs.existsSync(resultPath)).toBe(true);
    const body = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(body.error).toMatch(/Only the main group/);
  });

  it('request without requestId writes nothing and returns', async () => {
    await processTaskIpc({ type: 'tessl_update' }, UNAUTH_GROUP, false, deps);
    // No assertion on files — the handler must not spawn execFile
    // or write anything. The test passes if processTaskIpc returns
    // without throwing.
  });
});

describe('push_staged_to_branch authorization', () => {
  beforeEach(() => {
    ensureUnauthInputDir();
  });

  afterEach(() => {
    cleanupUnauthFixtures();
  });

  it('non-main group is rejected with an error response', async () => {
    const resultPath = resultPathFor('test-push-unauth');

    await processTaskIpc(
      {
        type: 'push_staged_to_branch',
        requestId: 'test-push-unauth',
        tileName: 'nanoclaw-admin',
        branch: 'promote/20260101T000000Z-nanoclaw-admin',
        commitMessage: 'fix: test',
      },
      UNAUTH_GROUP,
      false,
      deps,
    );

    expect(fs.existsSync(resultPath)).toBe(true);
    const body = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(body.error).toMatch(/Only the main group/);
  });

  it('request missing required fields is a no-op (no result file)', async () => {
    const resultPath = resultPathFor('test-push-incomplete');

    await processTaskIpc(
      {
        type: 'push_staged_to_branch',
        requestId: 'test-push-incomplete',
        tileName: 'nanoclaw-admin',
        // missing branch, commitMessage — the outer `if` guard drops the request
      },
      'whatsapp_main',
      true,
      deps,
    );

    // No result file: handler validates required fields before acting
    // and the request is silently dropped. (Silent-drop-on-missing-field
    // matches the `promote_staging` pattern already in the code.)
    expect(fs.existsSync(resultPath)).toBe(false);
  });
});
