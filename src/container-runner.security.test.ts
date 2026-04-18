import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// vi.mock is hoisted. vi.hoisted gives us values that exist at hoist time so
// the config mock factory can reference them without tripping TDZ.
const paths = vi.hoisted(() => {
  const root = `/tmp/nanoclaw-security-test-${process.pid}-${Date.now()}`;
  return {
    TEST_ROOT: root,
    STORE_DIR: `${root}/store`,
    DATA_DIR: `${root}/data`,
    GROUPS_DIR: `${root}/groups`,
    PROJECT_DIR: `${root}/project`,
  };
});

vi.mock('./config.js', () => ({
  STORE_DIR: paths.STORE_DIR,
  DATA_DIR: paths.DATA_DIR,
  GROUPS_DIR: paths.GROUPS_DIR,
  HOST_PROJECT_ROOT: paths.PROJECT_DIR,
  // HOST_UID: 0 short-circuits every `if (uid !== 0) fs.chownSync(...)` branch
  // so tests don't need to match the host's uid.
  HOST_UID: 0,
  HOST_GID: 0,
  CONTAINER_IMAGE: 'nanoclaw-agent:test',
  CONTAINER_MAX_OUTPUT_SIZE: 1_000_000,
  CONTAINER_TIMEOUT: 60_000,
  CREDENTIAL_PROXY_PORT: 3001,
  IDLE_TIMEOUT: 60_000,
  TILE_OWNER: 'test-owner',
  TIMEZONE: 'UTC',
  CONTAINER_VARS: {},
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

import {
  createFilteredDb,
  buildVolumeMounts,
  SECRET_FILES,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const { TEST_ROOT, STORE_DIR, DATA_DIR, GROUPS_DIR, PROJECT_DIR } = paths;

function seedMessagesDb(): string {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time INTEGER
    );
    CREATE TABLE messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      content TEXT,
      timestamp INTEGER,
      PRIMARY KEY (id, chat_jid)
    );
  `);
  // Two chats, each with two messages
  const insertChat = db.prepare(
    'INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)',
  );
  insertChat.run('chatA@g.us', 'Chat A', 1000);
  insertChat.run('chatB@g.us', 'Chat B', 2000);
  const insertMsg = db.prepare(
    'INSERT INTO messages (id, chat_jid, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)',
  );
  insertMsg.run('a1', 'chatA@g.us', 'alice', 'hello from A', 1001);
  insertMsg.run('a2', 'chatA@g.us', 'alice', 'second from A', 1002);
  insertMsg.run('b1', 'chatB@g.us', 'bob', 'hello from B', 2001);
  insertMsg.run('b2', 'chatB@g.us', 'bob', 'second from B', 2002);
  db.close();
  return dbPath;
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Test 1 — createFilteredDb isolates messages by chatJid.
// This is the untrusted-group DB isolation boundary. A regression here leaks
// other groups' messages into an untrusted container.
// -----------------------------------------------------------------------------
describe('createFilteredDb (untrusted DB isolation)', () => {
  it('returns null when source DB does not exist', () => {
    // Fresh tmpdir — no messages.db yet
    expect(createFilteredDb('chatA@g.us', 'folder-a')).toBe(null);
  });

  it('filtered DB contains only target chat rows, zero other-chat rows', () => {
    seedMessagesDb();
    const filtered = createFilteredDb('chatA@g.us', 'folder-a');
    expect(filtered).not.toBe(null);
    const db = new Database(filtered!, { readonly: true });
    try {
      const chats = db.prepare('SELECT jid FROM chats').all() as {
        jid: string;
      }[];
      const messages = db
        .prepare('SELECT id, chat_jid FROM messages')
        .all() as { id: string; chat_jid: string }[];

      expect(chats).toEqual([{ jid: 'chatA@g.us' }]);
      expect(messages.length).toBe(2);
      expect(messages.every((m) => m.chat_jid === 'chatA@g.us')).toBe(true);
      // Explicit negative: chatB must not leak through
      expect(messages.find((m) => m.id === 'b1')).toBeUndefined();
      expect(messages.find((m) => m.id === 'b2')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("SQL-injection-shaped chatJid doesn't leak other chats", () => {
    seedMessagesDb();
    // If the code naively interpolated, this would return every row. The
    // escaper doubles single quotes, so the whole string becomes a literal
    // that matches zero jids.
    const filtered = createFilteredDb("' OR '1'='1", 'folder-inject');
    const db = new Database(filtered!, { readonly: true });
    try {
      const chatCount = (
        db.prepare('SELECT COUNT(*) AS c FROM chats').get() as { c: number }
      ).c;
      const msgCount = (
        db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
      ).c;
      expect(chatCount).toBe(0);
      expect(msgCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it('second call overwrites the stale filtered DB', () => {
    seedMessagesDb();
    const first = createFilteredDb('chatA@g.us', 'folder-a');
    // Add a new message to the source after the first filter
    const src = new Database(path.join(STORE_DIR, 'messages.db'));
    src
      .prepare(
        'INSERT INTO messages (id, chat_jid, sender, content, timestamp) VALUES (?, ?, ?, ?, ?)',
      )
      .run('a3', 'chatA@g.us', 'alice', 'third from A', 1003);
    src.close();

    const second = createFilteredDb('chatA@g.us', 'folder-a');
    expect(second).toBe(first); // same path

    const db = new Database(second!, { readonly: true });
    try {
      const count = (
        db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
      ).c;
      // If the stale copy had been kept, count would still be 2.
      expect(count).toBe(3);
    } finally {
      db.close();
    }
  });
});

// -----------------------------------------------------------------------------
// Test 2 — SECRET_FILES list + main-group shadow mounts.
// Defense against agents reading bot tokens directly. Pinning the list
// catches accidental deletions; pinning the mount loop catches shadow regressions.
// -----------------------------------------------------------------------------
describe('SECRET_FILES and main-group shadow mounts', () => {
  // Pinned list — updating this requires updating the orchestrator
  // shadow logic AND documenting why the new file contains secrets.
  it('SECRET_FILES pins the full list of secret files to shadow', () => {
    expect([...SECRET_FILES]).toEqual([
      '.env',
      '.env.bak',
      'data/env/env',
      'scripts/heartbeat-external.conf',
    ]);
  });

  it('main group gets /dev/null shadow mount for every existing secret file', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      // Create each secret file so the exists-check passes
      for (const rel of SECRET_FILES) {
        const abs = path.join(PROJECT_DIR, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'SECRET=xyz');
      }

      const group: RegisteredGroup = {
        name: 'Main',
        folder: 'main-group',
        trigger: '@Main',
        added_at: new Date().toISOString(),
      };
      // buildVolumeMounts writes AGENTS.md into the group folder — pre-create it
      fs.mkdirSync(path.join(GROUPS_DIR, group.folder), { recursive: true });
      const mounts = buildVolumeMounts(group, true, 'main@g.us');

      const shadowMounts = mounts.filter((m) => m.hostPath === '/dev/null');
      expect(shadowMounts.length).toBe(SECRET_FILES.length);
      expect(shadowMounts.every((m) => m.readonly === true)).toBe(true);

      const shadowedContainerPaths = shadowMounts
        .map((m) => m.containerPath)
        .sort();
      const expected = SECRET_FILES.map(
        (rel) => `/workspace/project/${rel}`,
      ).sort();
      expect(shadowedContainerPaths).toEqual(expected);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('missing secret files are skipped (no shadow mount for absent files)', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      // Create all but .env.bak
      for (const rel of SECRET_FILES) {
        if (rel === '.env.bak') continue;
        const abs = path.join(PROJECT_DIR, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'SECRET=xyz');
      }

      const group: RegisteredGroup = {
        name: 'Main',
        folder: 'main-group',
        trigger: '@Main',
        added_at: new Date().toISOString(),
      };
      // buildVolumeMounts writes AGENTS.md into the group folder — pre-create it
      fs.mkdirSync(path.join(GROUPS_DIR, group.folder), { recursive: true });
      const mounts = buildVolumeMounts(group, true, 'main@g.us');

      const shadowMounts = mounts.filter((m) => m.hostPath === '/dev/null');
      // One fewer than the full list
      expect(shadowMounts.length).toBe(SECRET_FILES.length - 1);
      expect(
        shadowMounts.find(
          (m) => m.containerPath === '/workspace/project/.env.bak',
        ),
      ).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

// -----------------------------------------------------------------------------
// Test 3 — untrusted group gets read-only group mount + filtered-DB store mount.
// Two invariants in one test: disk-exhaustion protection (:ro on /workspace/group)
// and DB isolation (filtered-db path, not the full store/).
// -----------------------------------------------------------------------------
describe('buildVolumeMounts — untrusted group isolation', () => {
  function makeUntrustedGroup(): RegisteredGroup {
    return {
      name: 'Untrusted',
      folder: 'untrusted-group',
      trigger: '@U',
      added_at: new Date().toISOString(),
      // containerConfig.trusted deliberately unset → untrusted tier
    };
  }

  beforeEach(() => {
    // Seed a messages.db so createFilteredDb has something to copy from
    seedMessagesDb();
    // Pre-create the group folder (buildVolumeMounts writes AGENTS.md into it)
    fs.mkdirSync(path.join(GROUPS_DIR, 'untrusted-group'), { recursive: true });
    // Create SOUL-untrusted.md so the sanitized SOUL mount appears
    const globalDir = path.join(GROUPS_DIR, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'SOUL-untrusted.md'),
      '# Untrusted SOUL',
    );
  });

  it('/workspace/group mount is read-only for untrusted groups', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      const mounts = buildVolumeMounts(
        makeUntrustedGroup(),
        false,
        'chatA@g.us',
      );
      const groupMount = mounts.find(
        (m) => m.containerPath === '/workspace/group',
      );
      expect(groupMount).toBeDefined();
      expect(groupMount!.readonly).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('/workspace/store mount points at the filtered DB, not the full store', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      const mounts = buildVolumeMounts(
        makeUntrustedGroup(),
        false,
        'chatA@g.us',
      );
      const storeMount = mounts.find(
        (m) => m.containerPath === '/workspace/store',
      );
      expect(storeMount).toBeDefined();
      const expectedFilteredDir = path.join(
        DATA_DIR,
        'filtered-db',
        'untrusted-group',
      );
      expect(storeMount!.hostPath).toBe(expectedFilteredDir);
      // Critically: NOT the real store dir
      expect(storeMount!.hostPath).not.toBe(STORE_DIR);
      expect(storeMount!.hostPath).not.toBe(path.join(PROJECT_DIR, 'store'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('untrusted groups get zero secret-shadow mounts (main-only defense)', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      // Even if the secret files exist on disk, untrusted groups shouldn't
      // trigger the shadow logic — they don't mount the project root at all.
      for (const rel of SECRET_FILES) {
        const abs = path.join(PROJECT_DIR, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'SECRET=xyz');
      }
      const mounts = buildVolumeMounts(
        makeUntrustedGroup(),
        false,
        'chatA@g.us',
      );
      const shadowMounts = mounts.filter((m) => m.hostPath === '/dev/null');
      expect(shadowMounts.length).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('untrusted groups get SOUL-untrusted.md, not the full global dir', () => {
    const originalCwd = process.cwd();
    process.chdir(PROJECT_DIR);
    try {
      const mounts = buildVolumeMounts(
        makeUntrustedGroup(),
        false,
        'chatA@g.us',
      );
      const soulMount = mounts.find(
        (m) => m.containerPath === '/workspace/global/SOUL.md',
      );
      expect(soulMount).toBeDefined();
      expect(soulMount!.hostPath).toBe(
        path.join(GROUPS_DIR, 'global', 'SOUL-untrusted.md'),
      );
      expect(soulMount!.readonly).toBe(true);
      // And there's NO mount of the full global dir
      const globalDirMount = mounts.find(
        (m) => m.containerPath === '/workspace/global',
      );
      expect(globalDirMount).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });
});
