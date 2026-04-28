import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  _writeRawRegisteredGroup,
  createTask,
  deleteRegisteredGroup,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getBotMessageByTelegramId,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';
import { formatMessages } from './router.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- reply context persistence ---

describe('reply context', () => {
  it('stores and retrieves reply_to fields', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-1',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Yes, on my way!',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '42',
      reply_to_message_content: 'Are you coming tonight?',
      reply_to_sender_name: 'Bob',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('42');
    expect(messages[0].reply_to_message_content).toBe(
      'Are you coming tonight?',
    );
    expect(messages[0].reply_to_sender_name).toBe('Bob');
  });

  it('returns null for messages without reply context', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'no-reply',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Just a normal message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBeNull();
    expect(messages[0].reply_to_message_content).toBeNull();
    expect(messages[0].reply_to_sender_name).toBeNull();
  });

  it('retrieves reply context via getNewMessages', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-2',
      chat_jid: 'group@g.us',
      sender: '456',
      sender_name: 'Carol',
      content: 'Agreed',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '99',
      reply_to_message_content: 'We should meet',
      reply_to_sender_name: 'Dave',
    });

    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('99');
    expect(messages[0].reply_to_sender_name).toBe('Dave');
  });
});

// --- telegram_message_id persistence ---

describe('telegram_message_id', () => {
  it('stores and retrieves the telegram_message_id on a bot send', () => {
    storeChatMetadata('tg:-100123', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'bot-1776570796407-k6ie5',
      chat_jid: 'tg:-100123',
      sender: 'Andy',
      sender_name: 'Andy',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: true,
      is_bot_message: true,
      telegram_message_id: '4976',
    });

    const found = getBotMessageByTelegramId('tg:-100123', '4976');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('bot-1776570796407-k6ie5');
    expect(found?.telegram_message_id).toBe('4976');
    expect(found?.content).toBe('hello');
    expect(found?.is_bot_message).toBe(true);
  });

  it('returns null when no bot message has that telegram id', () => {
    storeChatMetadata('tg:-100123', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'bot-a',
      chat_jid: 'tg:-100123',
      sender: 'Andy',
      sender_name: 'Andy',
      content: 'x',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: true,
      is_bot_message: true,
      telegram_message_id: '4976',
    });

    expect(getBotMessageByTelegramId('tg:-100123', '9999')).toBeNull();
  });

  it('scopes lookup to chat_jid so the same telegram id in a different chat is ignored', () => {
    // Telegram IDs reset per chat — id 500 in chat A and chat B are different
    // messages. The getter is (chat_jid, telegram_message_id)-scoped so a
    // caller asking about chat A doesn't accidentally get chat B's row.
    storeChatMetadata('tg:-100aaa', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('tg:-100bbb', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'bot-a',
      chat_jid: 'tg:-100aaa',
      sender: 'Andy',
      sender_name: 'Andy',
      content: 'in chat A',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: true,
      is_bot_message: true,
      telegram_message_id: '500',
    });
    storeMessage({
      id: 'bot-b',
      chat_jid: 'tg:-100bbb',
      sender: 'Andy',
      sender_name: 'Andy',
      content: 'in chat B',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: true,
      is_bot_message: true,
      telegram_message_id: '500',
    });

    expect(getBotMessageByTelegramId('tg:-100aaa', '500')?.content).toBe(
      'in chat A',
    );
    expect(getBotMessageByTelegramId('tg:-100bbb', '500')?.content).toBe(
      'in chat B',
    );
  });

  it('leaves telegram_message_id unset when the caller omits it', () => {
    // Inbound user messages and other-channel sends never populate this
    // column — and a lookup by the telegram id those messages DO have as
    // their `id` should NOT resolve through this getter either (the query
    // checks telegram_message_id, not id).
    storeChatMetadata('tg:-100123', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: '4975', // simulate inbound user message — id IS the telegram id
      chat_jid: 'tg:-100123',
      sender: 'user@test',
      sender_name: 'User',
      content: 'hi bot',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    // Looking up by the same string returns null because
    // telegram_message_id column is NULL for this row.
    expect(getBotMessageByTelegramId('tg:-100123', '4975')).toBeNull();
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('recovers cursor from last bot reply when lastAgentTimestamp is missing', () => {
    // beforeEach already inserts m3 (bot reply at 00:00:03) and m4 (user at 00:00:04)
    // Add more old history before the bot reply
    for (let i = 1; i <= 50; i++) {
      store({
        id: `history-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `old message ${i}`,
        timestamp: `2023-06-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    // New message after the bot reply (m3 at 00:00:03)
    store({
      id: 'new-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'new message after bot reply',
      timestamp: '2024-01-02T00:00:00.000Z',
    });

    // Recover cursor from the last bot message (m3 from beforeEach)
    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // Using recovered cursor: only gets messages after the bot reply
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    // m4 (third, 00:00:04) + new-1 — skips all 50 old messages and m1/m2
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('third');
    expect(msgs[1].content).toBe('new message after bot reply');
  });

  it('caps messages to configured limit even with recovered cursor', () => {
    // beforeEach inserts m3 (bot at 00:00:03). Add 30 messages after it.
    for (let i = 1; i <= 30; i++) {
      store({
        id: `pending-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `pending message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // With limit=10, only the 10 most recent are returned
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    expect(msgs).toHaveLength(10);
    // Most recent 10: pending-21 through pending-30
    expect(msgs[0].content).toBe('pending message 21');
    expect(msgs[9].content).toBe('pending message 30');
  });

  it('returns last N messages when no bot reply and no cursor exist', () => {
    // Use a fresh group with no bot messages
    storeChatMetadata('fresh@g.us', '2024-01-01T00:00:00.000Z');
    for (let i = 1; i <= 20; i++) {
      store({
        id: `fresh-${i}`,
        chat_jid: 'fresh@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('fresh@g.us', 'Andy');
    expect(recovered).toBeUndefined();

    // No cursor → sinceTimestamp = '' but limit caps the result
    const msgs = getMessagesSince('fresh@g.us', '', 'Andy', 10);
    expect(msgs).toHaveLength(10);

    const prompt = formatMessages(msgs, 'Asia/Jerusalem');
    const messageTagCount = (prompt.match(/<message /g) || []).length;
    expect(messageTagCount).toBe(10);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      created_by_role: 'owner' as const,
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      created_by_role: 'owner' as const,
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      created_by_role: 'owner' as const,
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });

  // --- continuation_cycle_id (#93/#130) ---
  //
  // The column is opt-in: ordinary tasks omit it (DB stores NULL) and
  // the helper skill that drives self-resuming cycles supplies the slot
  // key (UTC date / ISO week per the proposal). The task-scheduler
  // reads the value verbatim and threads it through ContainerInput so
  // the spawned container gets the matching env vars; persistence
  // round-tripping is therefore the part the DB layer must guarantee.
  it('persists continuation_cycle_id when supplied', () => {
    createTask({
      id: 'task-cont-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'continue nightly chain',
      schedule_type: 'once',
      schedule_value: '2026-04-21T00:00:30.000Z',
      context_mode: 'isolated',
      next_run: '2026-04-21T00:00:30.000Z',
      status: 'active',
      created_at: '2026-04-21T00:00:00.000Z',
      created_by_role: 'owner' as const,
      continuation_cycle_id: '2026-04-21',
    });

    const task = getTaskById('task-cont-1');
    expect(task).toBeDefined();
    expect(task!.continuation_cycle_id).toBe('2026-04-21');
  });

  it('stores continuation_cycle_id as NULL when omitted (ordinary task)', () => {
    createTask({
      id: 'task-cont-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'fresh task',
      schedule_type: 'once',
      schedule_value: '2026-04-21T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-04-21T00:00:00.000Z',
      created_by_role: 'owner' as const,
    });

    const task = getTaskById('task-cont-2');
    expect(task).toBeDefined();
    // DB column is TEXT NULL; better-sqlite3 surfaces SQL NULL as
    // JS `null`, NOT `undefined`. The calling code uses
    // `task.continuation_cycle_id ?? undefined` to normalise back to
    // the optional-string ContainerInput field, so any non-null result
    // here would silently emit continuation env vars on a fresh task.
    expect(task!.continuation_cycle_id).toBeNull();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- deleteRegisteredGroup (#159) ---

describe('deleteRegisteredGroup', () => {
  it('removes a registered row and returns true', () => {
    setRegisteredGroup('purge@g.us', {
      name: 'Purge Me',
      folder: 'purge-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    expect(getRegisteredGroup('purge@g.us')).toBeDefined();

    const removed = deleteRegisteredGroup('purge@g.us');

    expect(removed).toBe(true);
    expect(getRegisteredGroup('purge@g.us')).toBeUndefined();
  });

  it('is idempotent — repeat calls report false after first delete', () => {
    setRegisteredGroup('once@g.us', {
      name: 'Once',
      folder: 'once-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    expect(deleteRegisteredGroup('once@g.us')).toBe(true);
    expect(deleteRegisteredGroup('once@g.us')).toBe(false);
  });

  it('returns false for a JID that was never registered', () => {
    expect(deleteRegisteredGroup('never-here@g.us')).toBe(false);
  });

  it('does not affect sibling registrations', () => {
    setRegisteredGroup('keeper@g.us', {
      name: 'Keeper',
      folder: 'keeper-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    setRegisteredGroup('goer@g.us', {
      name: 'Goer',
      folder: 'goer-group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    deleteRegisteredGroup('goer@g.us');

    expect(getRegisteredGroup('goer@g.us')).toBeUndefined();
    expect(getRegisteredGroup('keeper@g.us')).toBeDefined();
  });
});

// --- Defensive container_config parsing (issue #156) ---

describe('registered group malformed container_config', () => {
  it('getAllRegisteredGroups skips parse errors and keeps loading other rows', () => {
    setRegisteredGroup('good@g.us', {
      name: 'Good Group',
      folder: 'whatsapp_good',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      containerConfig: { trusted: true },
    });

    _writeRawRegisteredGroup({
      jid: 'broken@g.us',
      name: 'Broken Group',
      folder: 'whatsapp_broken',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      container_config: '{not valid json',
    });

    const groups = getAllRegisteredGroups();

    expect(groups['good@g.us']).toBeDefined();
    expect(groups['good@g.us'].containerConfig).toEqual({ trusted: true });

    expect(groups['broken@g.us']).toBeDefined();
    expect(groups['broken@g.us'].containerConfig).toBeUndefined();
    expect(groups['broken@g.us'].name).toBe('Broken Group');
  });

  it('getRegisteredGroup returns the row with containerConfig undefined on parse failure', () => {
    _writeRawRegisteredGroup({
      jid: 'broken@g.us',
      name: 'Broken Group',
      folder: 'whatsapp_broken',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      container_config: '{"trusted": tru',
    });

    const group = getRegisteredGroup('broken@g.us');
    expect(group).toBeDefined();
    expect(group?.containerConfig).toBeUndefined();
    expect(group?.name).toBe('Broken Group');
  });

  it('treats valid-but-non-object JSON (null, primitives, arrays) as undefined', () => {
    const cases = ['null', 'true', '42', '"oops"', '[]'];
    for (let i = 0; i < cases.length; i++) {
      const jid = `non-object-${i}@g.us`;
      _writeRawRegisteredGroup({
        jid,
        name: `Group ${i}`,
        folder: `whatsapp_non_object_${i}`,
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        container_config: cases[i],
      });
      const group = getRegisteredGroup(jid);
      expect(group).toBeDefined();
      expect(group?.containerConfig).toBeUndefined();
    }
  });

  it('treats empty-string container_config as parse failure (corruption indicator), not "no config"', async () => {
    const loggerMod = await import('./logger.js');
    const warnSpy = vi
      .spyOn(loggerMod.logger, 'warn')
      .mockImplementation(() => loggerMod.logger);

    _writeRawRegisteredGroup({
      jid: 'empty@g.us',
      name: 'Empty Config Group',
      folder: 'whatsapp_empty',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      container_config: '',
    });
    _writeRawRegisteredGroup({
      jid: 'null@g.us',
      name: 'Null Config Group',
      folder: 'whatsapp_null',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      container_config: null,
    });

    const empty = getRegisteredGroup('empty@g.us');
    expect(empty?.containerConfig).toBeUndefined();
    // Behavioral DIFFERENCE vs the old `if (!raw)` shape: empty
    // string now surfaces as a SyntaxError warning, while the
    // documented NULL "no config" state stays silent.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'empty@g.us', errName: 'SyntaxError' }),
      expect.stringContaining('invalid container_config JSON'),
    );

    warnSpy.mockClear();
    const nul = getRegisteredGroup('null@g.us');
    expect(nul?.containerConfig).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
