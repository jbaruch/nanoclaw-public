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

// Same TEST_DATA_DIR isolation pattern as ipc-auth.test.ts: chat_status
// and nuke_chat both write `_script_result_<requestId>.json` files via
// `scriptResultPath`, which uses `DATA_DIR`. Mocking it to a per-pid
// tempdir keeps these tests from clobbering a developer's real data
// dir or the orchestrator's live IPC tree.
const { TEST_DATA_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osMod = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require('path') as typeof import('path');
  return {
    TEST_DATA_DIR: pathMod.join(
      osMod.tmpdir(),
      `nanoclaw-chat-status-test-${process.pid}`,
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

import { _initTestDatabase, storeChatMetadata, storeMessage } from './db.js';
import type { ContainerStatus } from './group-queue.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const TRUSTED_GROUP: RegisteredGroup = {
  name: 'Trusted Friends',
  folder: 'trusted-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
  containerConfig: { trusted: true },
};

const UNTRUSTED_GROUP: RegisteredGroup = {
  name: 'Random Chat',
  folder: 'random-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
  // No containerConfig.trusted → untrusted
};

// Two groups sharing a name — exercises the chat_name ambiguity branch.
const TWIN_GROUP_A: RegisteredGroup = {
  name: 'Twin',
  folder: 'twin-a',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};
const TWIN_GROUP_B: RegisteredGroup = {
  name: 'Twin',
  folder: 'twin-b',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let nukeCalls: Array<{
  folder: string;
  session: 'default' | 'maintenance' | 'all';
}>;
let statusOverrides: Map<string, ContainerStatus>;
let nukeShouldThrow: Error | null;
let deps: IpcDeps;

const ADMIN_INPUT_DIR = path.join(
  TEST_DATA_DIR,
  'ipc',
  MAIN_GROUP.folder,
  'input-default',
);
const NON_ADMIN_INPUT_DIR = path.join(
  TEST_DATA_DIR,
  'ipc',
  UNTRUSTED_GROUP.folder,
  'input-default',
);

function ensureDirs(): void {
  fs.mkdirSync(ADMIN_INPUT_DIR, { recursive: true });
  fs.mkdirSync(NON_ADMIN_INPUT_DIR, { recursive: true });
}

function readResult(sourceFolder: string, requestId: string): unknown {
  const p = path.join(
    TEST_DATA_DIR,
    'ipc',
    sourceFolder,
    'input-default',
    `_script_result_${requestId}.json`,
  );
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

beforeEach(() => {
  _initTestDatabase();
  ensureDirs();

  groups = {
    'main@g.us': MAIN_GROUP,
    'trusted@g.us': TRUSTED_GROUP,
    'random@g.us': UNTRUSTED_GROUP,
    'twin-a@g.us': TWIN_GROUP_A,
    'twin-b@g.us': TWIN_GROUP_B,
  };
  nukeCalls = [];
  statusOverrides = new Map();
  nukeShouldThrow = null;

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    unregisterGroup: () => false,
    setGroupTrusted: () => true,
    setGroupTrigger: () => true,
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    nukeSession: (folder, session) => {
      if (nukeShouldThrow) throw nukeShouldThrow;
      nukeCalls.push({ folder, session });
    },
    getContainerStatus: (jid, sessionName) => {
      const key = `${jid}::${sessionName}`;
      return statusOverrides.get(key) ?? 'not-spawned';
    },
  };
});

afterEach(() => {
  // Wipe the entire IPC tree under TEST_DATA_DIR so each test starts
  // fresh — leftover `_script_result_*.json` files would cause the
  // "no result written" assertions to spuriously pass on the next run.
  const ipcRoot = path.join(TEST_DATA_DIR, 'ipc');
  if (fs.existsSync(ipcRoot)) {
    fs.rmSync(ipcRoot, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

// --- chat_status authorization ---

describe('chat_status authorization', () => {
  it('non-main group is rejected with an error response', async () => {
    await processTaskIpc(
      { type: 'chat_status', requestId: 'unauth-1' },
      UNTRUSTED_GROUP.folder,
      false,
      deps,
    );

    const body = readResult(UNTRUSTED_GROUP.folder, 'unauth-1') as {
      error?: string;
    };
    expect(body.error).toMatch(/admin-tile only/);
  });

  it('main group is allowed and returns a chats array', async () => {
    await processTaskIpc(
      { type: 'chat_status', requestId: 'auth-1' },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'auth-1') as { stdout: string };
    const payload = JSON.parse(body.stdout);
    expect(Array.isArray(payload.chats)).toBe(true);
    expect(payload.chats).toHaveLength(Object.keys(groups).length);
  });
});

// --- chat_status filter resolution ---

describe('chat_status filtering', () => {
  it('chat_id filter returns just that chat', async () => {
    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'filter-1',
        chat_id: 'trusted@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'filter-1') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.chats).toHaveLength(1);
    expect(payload.chats[0].chat_id).toBe('trusted@g.us');
    expect(payload.chats[0].chat_name).toBe('Trusted Friends');
  });

  it('chat_id filter rejects an unregistered JID', async () => {
    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'filter-2',
        chat_id: 'ghost@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'filter-2') as {
      error?: string;
    };
    expect(body.error).toMatch(/not registered/);
  });

  it('chat_name filter resolves a unique name', async () => {
    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'filter-3',
        chat_name: 'Trusted Friends',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'filter-3') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.chats).toHaveLength(1);
    expect(payload.chats[0].chat_id).toBe('trusted@g.us');
  });

  it('chat_name filter returns ambiguity error when multiple chats share a name', async () => {
    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'filter-4',
        chat_name: 'Twin',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'filter-4') as {
      error?: string;
      candidates?: string[];
    };
    expect(body.error).toMatch(/ambiguous/);
    expect(body.candidates).toEqual(
      expect.arrayContaining(['twin-a@g.us', 'twin-b@g.us']),
    );
  });

  it('chat_name filter returns not-found error when no chat matches', async () => {
    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'filter-5',
        chat_name: 'Nonexistent',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'filter-5') as {
      error?: string;
    };
    expect(body.error).toMatch(/did not match/);
  });
});

// --- chat_status payload shape ---

describe('chat_status payload', () => {
  it('classifies the main group as admin and untriggered', async () => {
    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'payload-1',
        chat_id: 'main@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'payload-1') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.chats[0].tile).toBe('admin');
    // Main groups bypass the trigger check entirely — the canonical
    // value is 'untriggered' regardless of requiresTrigger storage.
    expect(payload.chats[0].trigger).toBe('untriggered');
  });

  it('classifies trusted vs untrusted groups correctly', async () => {
    await processTaskIpc(
      { type: 'chat_status', requestId: 'payload-2' },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'payload-2') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    const byJid = Object.fromEntries(
      payload.chats.map((c: { chat_id: string }) => [c.chat_id, c]),
    );
    expect(byJid['trusted@g.us'].tile).toBe('trusted');
    expect(byJid['random@g.us'].tile).toBe('untrusted');
  });

  it('marks non-main groups with requiresTrigger !== false as triggered', async () => {
    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'payload-3',
        chat_id: 'random@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'payload-3') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.chats[0].trigger).toBe('triggered');
  });

  it('marks non-main groups with requiresTrigger === false as untriggered', async () => {
    groups['random@g.us'] = { ...UNTRUSTED_GROUP, requiresTrigger: false };
    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'payload-4',
        chat_id: 'random@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'payload-4') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.chats[0].trigger).toBe('untriggered');
  });

  it('returns null last_ayeaye_message when Andy never spoke in the chat', async () => {
    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'payload-5',
        chat_id: 'random@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'payload-5') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.chats[0].last_ayeaye_message).toBeNull();
  });

  it('returns the most recent is_from_me=1 message with content snippet', async () => {
    // Foreign key on messages.chat_jid → chats.jid, so we must seed
    // the chats row before storing messages. storeChatMetadata is the
    // canonical seeding path.
    storeChatMetadata(
      'random@g.us',
      '2026-04-25T09:00:00.000Z',
      'Random Chat',
      'telegram',
      true,
    );
    storeMessage({
      id: 'bot-1',
      chat_jid: 'random@g.us',
      sender: 'Andy',
      sender_name: 'Andy',
      content: 'first reply',
      timestamp: '2026-04-25T10:00:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
    storeMessage({
      id: 'bot-2',
      chat_jid: 'random@g.us',
      sender: 'Andy',
      sender_name: 'Andy',
      content: 'second reply',
      timestamp: '2026-04-25T11:00:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'payload-6',
        chat_id: 'random@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'payload-6') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.chats[0].last_ayeaye_message).toEqual({
      timestamp: '2026-04-25T11:00:00.000Z',
      content_snippet: 'second reply',
    });
  });

  it('truncates a long bot message to 200 chars with an ellipsis', async () => {
    storeChatMetadata(
      'random@g.us',
      '2026-04-25T09:00:00.000Z',
      'Random Chat',
      'telegram',
      true,
    );
    const longContent = 'x'.repeat(500);
    storeMessage({
      id: 'bot-long',
      chat_jid: 'random@g.us',
      sender: 'Andy',
      sender_name: 'Andy',
      content: longContent,
      timestamp: '2026-04-25T12:00:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'payload-7',
        chat_id: 'random@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'payload-7') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    const snippet = payload.chats[0].last_ayeaye_message.content_snippet;
    expect(snippet.endsWith('…')).toBe(true);
    // 200 'x' chars + the ellipsis.
    expect(snippet).toBe('x'.repeat(200) + '…');
  });

  it('reports per-session container status from the deps callback', async () => {
    statusOverrides.set('random@g.us::default', 'crashed');
    statusOverrides.set('random@g.us::maintenance', 'cooling-down');

    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'payload-8',
        chat_id: 'random@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'payload-8') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.chats[0].containers).toEqual({
      default: 'crashed',
      maintenance: 'cooling-down',
    });
  });

  it('falls back to not-spawned when getContainerStatus dep is missing', async () => {
    const depsWithoutStatus = { ...deps, getContainerStatus: undefined };
    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'payload-9',
        chat_id: 'random@g.us',
      },
      MAIN_GROUP.folder,
      true,
      depsWithoutStatus,
    );

    const body = readResult(MAIN_GROUP.folder, 'payload-9') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.chats[0].containers).toEqual({
      default: 'not-spawned',
      maintenance: 'not-spawned',
    });
  });
});

// --- nuke_chat authorization & validation ---

describe('nuke_chat authorization', () => {
  it('non-main group is rejected with an error response', async () => {
    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-unauth',
        chat_id: 'random@g.us',
      },
      UNTRUSTED_GROUP.folder,
      false,
      deps,
    );

    const body = readResult(UNTRUSTED_GROUP.folder, 'nuke-unauth') as {
      error?: string;
    };
    expect(body.error).toMatch(/admin-tile only/);
    expect(nukeCalls).toHaveLength(0);
  });

  it('hard-fails when neither chat_id nor chat_name is provided', async () => {
    await processTaskIpc(
      { type: 'nuke_chat', requestId: 'nuke-no-id' },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'nuke-no-id') as {
      error?: string;
    };
    expect(body.error).toMatch(/cross-chat/);
    expect(nukeCalls).toHaveLength(0);
  });

  it('whitespace-only chat_id is treated as missing (still hard-fails)', async () => {
    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-blank',
        chat_id: '   ',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'nuke-blank') as {
      error?: string;
    };
    expect(body.error).toMatch(/cross-chat/);
    expect(nukeCalls).toHaveLength(0);
  });
});

describe('nuke_chat resolution', () => {
  it('resolves chat_id and forwards to nukeSession with the right folder', async () => {
    // Mark default as running so the status enum lands on 'success' —
    // status='noop' would also be a legitimate outcome (no live slots
    // to kill), but this test is about chat_id resolution, not the
    // status enum, so make the precondition explicit.
    statusOverrides.set('random@g.us::default', 'running');

    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-id',
        chat_id: 'random@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    expect(nukeCalls).toEqual([{ folder: 'random-group', session: 'all' }]);

    const body = readResult(MAIN_GROUP.folder, 'nuke-id') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.chat_id).toBe('random@g.us');
    expect(payload.chat_name).toBe('Random Chat');
    expect(payload.status).toBe('success');
  });

  it('chat_id not registered → error response, nukeSession not called', async () => {
    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-missing',
        chat_id: 'ghost@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'nuke-missing') as {
      error?: string;
    };
    expect(body.error).toMatch(/not registered/);
    expect(nukeCalls).toHaveLength(0);
  });

  it('resolves chat_name when unique', async () => {
    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-name',
        chat_name: 'Random Chat',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    expect(nukeCalls).toEqual([{ folder: 'random-group', session: 'all' }]);
    const body = readResult(MAIN_GROUP.folder, 'nuke-name') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.chat_id).toBe('random@g.us');
  });

  it('chat_name ambiguity → error response with candidate JIDs, nukeSession not called', async () => {
    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-ambig',
        chat_name: 'Twin',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'nuke-ambig') as {
      error?: string;
      candidates?: string[];
    };
    expect(body.error).toMatch(/ambiguous/);
    expect(body.candidates).toEqual(
      expect.arrayContaining(['twin-a@g.us', 'twin-b@g.us']),
    );
    expect(nukeCalls).toHaveLength(0);
  });

  it('chat_name not found → error response, nukeSession not called', async () => {
    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-no-match',
        chat_name: 'Nonexistent',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'nuke-no-match') as {
      error?: string;
    };
    expect(body.error).toMatch(/did not match/);
    expect(nukeCalls).toHaveLength(0);
  });
});

describe('nuke_chat session arg', () => {
  it('passes session=default through to nukeSession', async () => {
    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-default',
        chat_id: 'random@g.us',
        session: 'default',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );
    expect(nukeCalls).toEqual([{ folder: 'random-group', session: 'default' }]);
  });

  it('passes session=maintenance through to nukeSession', async () => {
    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-maint',
        chat_id: 'random@g.us',
        session: 'maintenance',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );
    expect(nukeCalls).toEqual([
      { folder: 'random-group', session: 'maintenance' },
    ]);
  });

  it('falls back to "all" for an invalid session arg', async () => {
    // Cast bypasses TS — simulates a malformed payload arriving as
    // raw JSON. The IPC handler must not blindly forward unknown
    // values to `nukeSession`, which only accepts the enum.
    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-bogus',
        chat_id: 'random@g.us',
        session: 'bogus' as unknown as 'all',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );
    expect(nukeCalls).toEqual([{ folder: 'random-group', session: 'all' }]);
  });
});

describe('nuke_chat output', () => {
  it('reports killed_sessions for slots that were running or idle', async () => {
    statusOverrides.set('random@g.us::default', 'running');
    statusOverrides.set('random@g.us::maintenance', 'not-spawned');

    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-killed',
        chat_id: 'random@g.us',
        session: 'all',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'nuke-killed') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.killed_sessions).toEqual(['default']);
    expect(payload.status).toBe('success');
  });

  it('reports status="noop" when no slots were live', async () => {
    // All slots are not-spawned (the default override returns
    // not-spawned). Per the issue's status enum, "noop" is the right
    // signal — nothing live was killed even though the on-disk wipe
    // still happened. The previous "always success" behaviour made
    // every nuke_chat indistinguishable from one that actually freed
    // a stuck container.
    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-cold',
        chat_id: 'random@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'nuke-cold') as {
      stdout: string;
    };
    const payload = JSON.parse(body.stdout);
    expect(payload.killed_sessions).toEqual([]);
    expect(payload.status).toBe('noop');
  });

  it('reports top-level error field when nukeSession throws', async () => {
    nukeShouldThrow = new Error('disk full');

    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'nuke-err',
        chat_id: 'random@g.us',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    // Top-level `error` matters — runHostOperation in the agent-runner
    // surfaces `isError: true` only when `result.error` is set. If the
    // failure were buried inside `result.stdout` (the prior shape),
    // the MCP caller would get a misleading "successful" response.
    const body = readResult(MAIN_GROUP.folder, 'nuke-err') as {
      error?: string;
      chat_id?: string;
      chat_name?: string;
      killed_sessions?: string[];
      status?: string;
    };
    expect(body.error).toMatch(/disk full/);
    expect(body.error).toContain('random@g.us');
    expect(body.status).toBe('error');
    expect(body.killed_sessions).toEqual([]);
    expect(body.chat_id).toBe('random@g.us');
    expect(body.chat_name).toBe('Random Chat');
  });
});

// --- chat_status / nuke_chat XOR enforcement (Copilot review) ---

describe('chat_status / nuke_chat XOR enforcement', () => {
  it('chat_status rejects when both chat_id and chat_name are provided', async () => {
    await processTaskIpc(
      {
        type: 'chat_status',
        requestId: 'xor-1',
        chat_id: 'random@g.us',
        chat_name: 'Random Chat',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'xor-1') as {
      error?: string;
    };
    // Two identifiers that might disagree is unsafe targeting.
    // Reject — don't silently pick one and let the call go through.
    expect(body.error).toMatch(/not both/);
  });

  it('nuke_chat rejects when both chat_id and chat_name are provided, nukeSession not called', async () => {
    await processTaskIpc(
      {
        type: 'nuke_chat',
        requestId: 'xor-2',
        chat_id: 'random@g.us',
        chat_name: 'Random Chat',
      },
      MAIN_GROUP.folder,
      true,
      deps,
    );

    const body = readResult(MAIN_GROUP.folder, 'xor-2') as {
      error?: string;
    };
    expect(body.error).toMatch(/not both/);
    expect(nukeCalls).toHaveLength(0);
  });
});
