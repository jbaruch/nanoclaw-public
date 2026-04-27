import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  // Self-resuming cycles. Pre-existing scheduled_tasks tables (every
  // install before this change) lack the continuation_cycle_id column.
  // The migration must add it without breaking any existing rows;
  // ordinary tasks then read back as continuation_cycle_id = NULL,
  // which the scheduler normalises to `undefined` so the spawned
  // container gets no continuation env vars.
  it('adds continuation_cycle_id to a pre-existing scheduled_tasks table', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      // Legacy shape: scheduled_tasks WITHOUT continuation_cycle_id.
      // Mirrors the install before this change. The column is the
      // marker the scheduler reads to decide whether to plumb
      // NANOCLAW_CONTINUATION env vars onto the spawn.
      legacyDb.exec(`
        CREATE TABLE scheduled_tasks (
          id TEXT PRIMARY KEY,
          group_folder TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule_type TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          next_run TEXT,
          last_run TEXT,
          last_result TEXT,
          status TEXT DEFAULT 'active',
          created_at TEXT NOT NULL
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-task',
          'main',
          'main@g.us',
          'pre-existing task',
          'once',
          '2026-04-01T00:00:00.000Z',
          'active',
          '2026-04-01T00:00:00.000Z',
        );
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getTaskById, _closeDatabase } =
        await import('./db.js');

      // Must not throw — every column-add migration must be PRAGMA-gated
      // so a re-run on an already-upgraded DB is a no-op (idempotent).
      initDatabase();

      const upgradedDb = new Database(dbPath);
      const cols = upgradedDb
        .prepare('PRAGMA table_info(scheduled_tasks)')
        .all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'continuation_cycle_id')).toBe(true);
      upgradedDb.close();

      // Pre-existing row reads back with continuation_cycle_id = NULL.
      // The scheduler's `?? undefined` normalisation depends on this —
      // a non-null backfill default would silently emit continuation
      // env vars on every legacy task on first run after upgrade.
      const legacyTask = getTaskById('legacy-task');
      expect(legacyTask).toBeDefined();
      expect(legacyTask!.continuation_cycle_id).toBeNull();

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});
