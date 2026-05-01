import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  // Our fork's auto-react gate calls getTriggerPattern(group.trigger) to
  // build a per-group regex; tests don't override the trigger so the
  // mock returns the default pattern regardless of input.
  getTriggerPattern: (_trigger?: string) => /^@Andy\b/i,
  // GROUPS_DIR is imported at module load by the Telegram channel for
  // voice-transcription temp paths. Tests don't exercise voice; a stub
  // is fine.
  GROUPS_DIR: '/tmp/test-groups',
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db — telegram.ts imports a few helpers from `../db.js`. The
// only one our `sendMessage` cares about for this test file is
// `messageExistsInDifferentChat`, which guards cross-chat reply_to.
// Default to `false` (no evidence message lives elsewhere → preserve
// reply_to) so existing tests keep their semantics; individual
// cross-chat tests below override per-call.
const messageExistsInDifferentChatMock = vi.hoisted(() => vi.fn(() => false));
// `getMessageById` is consulted by `sendReaction` to translate legacy
// `bot-<ts>-<rand>` ids to the Telegram numeric message_id stored on
// the row. Hoisted so individual reaction tests can stub a row. See
// #50.
const getMessageByIdMock = vi.hoisted(() => vi.fn(() => null));
vi.mock('../db.js', () => ({
  getLatestMessage: vi.fn(() => null),
  getMessageById: getMessageByIdMock,
  messageExistsInDifferentChat: messageExistsInDifferentChatMock,
  storeReaction: vi.fn(),
}));

// Mock observer — `noteLatestUserMessage` is called by the voice handler
// to register the message ID for the observer's 🤔/⚡/✍ reaction cycle.
// The real impl writes to a module-level Map; mock it so tests don't
// bleed state across each other and can assert it was called.
const noteLatestUserMessageMock = vi.hoisted(() => vi.fn());
vi.mock('../observer.js', () => ({
  noteLatestUserMessage: noteLatestUserMessageMock,
}));

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));

// `InputFile` is constructed eagerly in `sendFile` from a path. The real
// grammy implementation touches the filesystem, which our tests don't
// stage — mock it to a passthrough wrapper so the sendDocument call
// site is exercised without hitting disk.
vi.mock('grammy', () => ({
  InputFile: class MockInputFile {
    constructor(public source: string | Buffer) {}
  },
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 1001 }),
      raw: {
        setMessageReaction: vi.fn().mockResolvedValue(undefined),
      },
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    async start(opts: { onStart: (botInfo: any) => void }) {
      // Real grammy Bot.start() returns a Promise; connect() attaches
      // a `.catch(...)` to it. Returning void would throw TypeError on
      // `.catch` access synchronously — tests pass today only because
      // onStart resolves the outer Promise before the TypeError
      // surfaces. Match the real API shape so stricter runtimes don't
      // trip.
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
}));

import {
  TelegramChannel,
  TelegramChannelOpts,
  sendPoolMessage,
} from './telegram.js';
import { logger } from '../logger.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      ...(overrides.extra || {}),
    },
    me: { username: 'andy_ai_bot' },
  };
}

function currentBot() {
  return botRef.current;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().commandHandlers.has('ping')).toBe(true);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
      expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video')).toBe(true);
      expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
      expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
      expect(currentBot().filterHandlers.has('message:document')).toBe(true);
      expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
      expect(currentBot().filterHandlers.has('message:location')).toBe(true);
      expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice (@alice_user)',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips bot commands (/chatid, /ping) but passes other / messages through', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Bot commands should be skipped
      const ctx1 = createTextCtx({ text: '/chatid' });
      await triggerTextMessage(ctx1);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      const ctx2 = createTextCtx({ text: '/ping' });
      await triggerTextMessage(ctx2);
      expect(opts.onMessage).not.toHaveBeenCalled();

      // Non-bot /commands should flow through
      const ctx3 = createTextCtx({ text: '/remote-control' });
      await triggerTextMessage(ctx3);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '/remote-control' }),
      );
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'Bob (@alice_user)' }),
      );
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'alice_user (@alice_user)' }),
      );
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: '42' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice (@alice_user)', // Private chats use sender name with username
        'telegram',
        false,
      );
    });

    it('uses chat title as name for group chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Project Team',
        'telegram',
        true,
      );
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot_username mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@andy_ai_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@Andy @andy_ai_bot hello',
        entities: [{ type: 'mention', offset: 6, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Should NOT double-prepend — already starts with @Andy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot hello',
        }),
      );
    });

    it('does not translate mentions of other bots', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@some_other_bot hi',
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@some_other_bot hi', // No translation
        }),
      );
    });

    it('handles mention in middle of message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'hey @andy_ai_bot check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Bot is mentioned, message doesn't match trigger → prepend trigger
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy hey @andy_ai_bot check this',
        }),
      );
    });

    it('handles message with no entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'plain message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'check https://example.com',
        entities: [{ type: 'url', offset: 6, length: 19 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'check https://example.com',
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores photo with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { photo: [{ file_id: 'f1', width: 100, height: 100 }] },
      });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Image]' }),
      );
    });

    it('stores photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        caption: 'Look at this',
        extra: { photo: [{ file_id: 'f1', width: 100, height: 100 }] },
      });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Image] Look at this',
        }),
      );
    });

    it('stores video with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores voice message with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { voice: { file_id: 'v1' } },
      });
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice message - transcription failed]',
        }),
      );
    });

    // --- voice message reactions (fix for #14 / lombot#17) ---

    it('emits 👀 reaction and noteLatestUserMessage immediately on voice in main group', async () => {
      // isMain group: no trigger required — reactions should fire BEFORE
      // transcription completes (i.e. before onMessage is called).
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Main',
            folder: 'main',
            trigger: '@Andy',
            isMain: true,
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        messageId: 8932,
        extra: { voice: { file_id: 'v1' } },
      });
      await triggerMediaMessage('message:voice', ctx);

      // noteLatestUserMessage must be called so the observer can attach
      // 🤔/⚡/✍ reactions as the agent works on the transcript.
      expect(noteLatestUserMessageMock).toHaveBeenCalledWith(
        'tg:100200300',
        '8932',
      );
      // 👀 reaction must fire on the voice message (setMessageReaction
      // is the Telegram API call behind sendReaction).
      expect(currentBot().api.raw.setMessageReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: '100200300',
          message_id: 8932,
          reaction: [{ type: 'emoji', emoji: '👀' }],
        }),
      );
      // onMessage still fires with the (failed) transcription result
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ id: '8932' }),
      );
    });

    it('emits 👀 reaction on voice in trusted group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Trusted Group',
            folder: 'trusted',
            trigger: '@Andy',
            requiresTrigger: true,
            containerConfig: { trusted: true },
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        messageId: 42,
        extra: { voice: { file_id: 'v2' } },
      });
      await triggerMediaMessage('message:voice', ctx);

      expect(noteLatestUserMessageMock).toHaveBeenCalledWith(
        'tg:100200300',
        '42',
      );
      expect(currentBot().api.raw.setMessageReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: '100200300',
          message_id: 42,
          reaction: [{ type: 'emoji', emoji: '👀' }],
        }),
      );
    });

    it('does NOT emit 👀 or noteLatestUserMessage on voice in untrusted trigger-required group', async () => {
      // Default createTestOpts() group has no isMain and no trusted flag.
      // requiresTrigger is undefined (defaults to true). The reaction
      // block must be skipped — we don't know whether the transcript will
      // contain the trigger word.
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ extra: { voice: { file_id: 'v3' } } });
      await triggerMediaMessage('message:voice', ctx);

      expect(noteLatestUserMessageMock).not.toHaveBeenCalled();
      expect(currentBot().api.raw.setMessageReaction).not.toHaveBeenCalled();
    });

    it('stores audio with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores document with filename', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { document: { file_name: 'report.pdf' } },
      });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Document: report.pdf - no file_id]',
        }),
      );
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ extra: { document: {} } });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: file - no file_id]' }),
      );
    });

    it('stores sticker with emoji', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        { parse_mode: 'HTML' },
      );
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Group message',
        { parse_mode: 'HTML' },
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
        { parse_mode: 'HTML' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        { parse_mode: 'HTML' },
      );
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Both Markdown and plain text fail
      currentBot().api.sendMessage.mockRejectedValue(
        new Error('Network error'),
      );

      // Should not throw — error is caught internally
      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect — bot is null
      await channel.sendMessage('tg:100200300', 'No bot');

      // No error, no API call
    });

    it('passes reply_parameters when replyToMessageId is local to the target chat', async () => {
      // messageExistsInDifferentChat returns false by default (mock
      // hoisted at top of file). With no cross-chat evidence, the
      // reply_to should be forwarded to Telegram unchanged.
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello', '4242');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        {
          parse_mode: 'HTML',
          reply_parameters: { message_id: 4242 },
        },
      );
    });

    it('drops reply_parameters when the referenced message lives in a different chat', async () => {
      // Reproduce the production bug: agent in chat A calls
      // send_message(chat_jid: B, reply_to: msg-from-A). Telegram
      // returns 400 "message to be replied not found" and the catch
      // swallows it silently. The DB knows that message lives in a
      // different chat, so we should drop reply_to before sending.
      messageExistsInDifferentChatMock.mockReturnValueOnce(true);

      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Cross-chat hello', '6968');

      // No reply_parameters in the options — just parse_mode.
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Cross-chat hello',
        { parse_mode: 'HTML' },
      );
      expect(messageExistsInDifferentChatMock).toHaveBeenCalledWith(
        '6968',
        'tg:100200300',
      );
    });

    it('returns the sent message id on success', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendMessage.mockResolvedValueOnce({
        message_id: 7777,
      });

      const result = await channel.sendMessage('tg:100200300', 'ok');

      // IPC handler now gates `storeMessage` on this return value, so
      // a truthy id is the success contract. Failures still resolve to
      // undefined (covered by the existing 'handles send failure
      // gracefully' test above).
      expect(result).toBe('7777');
    });
  });

  // --- sendFile ---

  describe('sendFile', () => {
    it('sends document with HTML-sanitized caption and parse_mode HTML', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendFile(
        'tg:100200300',
        '/tmp/nanoclaw-test.png',
        'feeling _great_ today',
      );

      expect(currentBot().api.sendDocument).toHaveBeenCalledTimes(1);
      const call = currentBot().api.sendDocument.mock.calls[0];
      expect(call[0]).toBe('100200300'); // tg: prefix stripped
      expect(call[2].parse_mode).toBe('HTML');
      // sanitizeTelegramHtml rewrites `_great_` → `<i>great</i>` (see
      // telegram-sanitize.test.ts) — proves the HTML path is active and
      // the caption went through the sanitizer, not a bypass.
      expect(call[2].caption).toBe('feeling <i>great</i> today');
    });

    it('sends without parse_mode when no caption is provided', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendFile('tg:100200300', '/tmp/nanoclaw-test.png');

      expect(currentBot().api.sendDocument).toHaveBeenCalledTimes(1);
      const options = currentBot().api.sendDocument.mock.calls[0][2];
      expect(options.caption).toBeUndefined();
      expect(options.parse_mode).toBeUndefined();
    });

    it('falls back to plain caption without parse_mode when HTML send fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // First call (HTML attempt) rejects; second call (plain fallback) resolves.
      currentBot()
        .api.sendDocument.mockRejectedValueOnce(
          new Error("can't parse entities"),
        )
        .mockResolvedValueOnce({ message_id: 2002 });

      await channel.sendFile(
        'tg:100200300',
        '/tmp/nanoclaw-test.png',
        'feeling _great_ today',
      );

      expect(currentBot().api.sendDocument).toHaveBeenCalledTimes(2);
      // Second call sends the ORIGINAL (pre-sanitize) caption with no
      // parse_mode — so a broken HTML-encoding edge case can't block a
      // file delivery; the worst case is literal markdown, never a
      // dropped attachment.
      const plainOptions = currentBot().api.sendDocument.mock.calls[1][2];
      expect(plainOptions.parse_mode).toBeUndefined();
      expect(plainOptions.caption).toBe('feeling _great_ today');
    });

    it('does not retry sendDocument when no caption was provided', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Caption-less sends can't benefit from the plain-caption
      // fallback (payload would be identical). A retry would just
      // double API traffic on transient network errors.
      currentBot().api.sendDocument.mockRejectedValue(
        new Error('network blip'),
      );

      // Should not throw — outer catch swallows.
      await expect(
        channel.sendFile('tg:100200300', '/tmp/nanoclaw-test.png'),
      ).resolves.toBeUndefined();

      expect(currentBot().api.sendDocument).toHaveBeenCalledTimes(1);
    });

    it('includes reply_parameters when replyToMessageId is provided', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendFile(
        'tg:100200300',
        '/tmp/nanoclaw-test.png',
        'hello',
        '4242',
      );

      const options = currentBot().api.sendDocument.mock.calls[0][2];
      expect(options.reply_parameters).toEqual({ message_id: 4242 });
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect — bot is null; should exit cleanly, not throw.
      await expect(
        channel.sendFile('tg:100200300', '/tmp/nanoclaw-test.png', 'hi'),
      ).resolves.toBeUndefined();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('tg:100200300', true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping('tg:100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:100200300'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });

  // --- sendReaction (#50, #51) ---

  describe('sendReaction', () => {
    it('passes the numeric Telegram message_id straight through when the caller already has it', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      await channel.sendReaction('tg:100200300', '485', '👍');
      expect(currentBot().api.raw.setMessageReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: '100200300',
          message_id: 485,
          reaction: [{ type: 'emoji', emoji: '👍' }],
        }),
      );
    });

    it('translates a legacy bot-<ts>-<rand> id to the numeric Telegram id stored on the row (#50)', async () => {
      // Newer bot rows are keyed on the numeric Telegram id (see ipc.ts /
      // index.ts). When sendReaction receives a legacy local id we look
      // up the row and reuse its (now-numeric) primary key.
      getMessageByIdMock.mockReturnValueOnce({
        id: '777',
        chat_jid: 'tg:100200300',
        sender: 'Andy',
        sender_name: 'Andy',
        content: 'hello',
        timestamp: '2026-04-29T00:00:00.000Z',
        is_from_me: true,
      } as any);
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      await channel.sendReaction(
        'tg:100200300',
        'bot-1777015856617-a7smw',
        '👍',
      );
      expect(getMessageByIdMock).toHaveBeenCalledWith(
        'bot-1777015856617-a7smw',
        'tg:100200300',
      );
      expect(currentBot().api.raw.setMessageReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: '100200300',
          message_id: 777,
          reaction: [{ type: 'emoji', emoji: '👍' }],
        }),
      );
    });

    it('skips the Telegram call (with WARN log) when a bot-<ts>-<rand> id has no row to translate against (#50)', async () => {
      // Pre-fix this case shipped the local id straight to Telegram, which
      // returned a 400 and logged at ERROR — 145 entries / 12h. Now we
      // skip with a warn that names the cause.
      getMessageByIdMock.mockReturnValueOnce(null);
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      await channel.sendReaction(
        'tg:100200300',
        'bot-1777015856617-a7smw',
        '👍',
      );
      expect(currentBot().api.raw.setMessageReaction).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          jid: 'tg:100200300',
          messageId: 'bot-1777015856617-a7smw',
        }),
        expect.stringContaining('Skipping Telegram reaction'),
      );
    });

    it('captures rejected emoji and original input in the WARN payload when normalization fails (#51)', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      // `:not_a_real_emoji:` will normalize-pass through (no shortcode
      // entry), then trip the TELEGRAM_ALLOWED_REACTIONS gate. The
      // post-fix log payload must carry both the rejected normalized
      // form and the original input — pre-fix the message body was a
      // bare string, so operators couldn't see what to fix.
      await channel.sendReaction('tg:100200300', '485', ':not_a_real_emoji:');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          rejectedEmoji: expect.any(String),
          originalInput: ':not_a_real_emoji:',
          using: '👍',
        }),
        'Invalid Telegram reaction emoji, falling back to 👍',
      );
      // Reaction still gets shipped with the 👍 fallback.
      expect(currentBot().api.raw.setMessageReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          reaction: [{ type: 'emoji', emoji: '👍' }],
        }),
      );
    });

    it('downgrades known-transient reaction failures (deleted message etc.) to WARN (#50 out-of-scope follow-up)', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      currentBot().api.raw.setMessageReaction.mockRejectedValueOnce(
        new Error('Bad Request: message to react to not found'),
      );
      await channel.sendReaction('tg:100200300', '485', '👍');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:100200300', messageId: '485' }),
        expect.stringContaining('Telegram reaction skipped'),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('still logs at ERROR for unexpected reaction failures', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      currentBot().api.raw.setMessageReaction.mockRejectedValueOnce(
        new Error('Internal Server Error'),
      );
      await channel.sendReaction('tg:100200300', '485', '👍');
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:100200300', messageId: '485' }),
        'Failed to send Telegram reaction',
      );
    });

    // The transient downgrade originally covered only the
    // `message to react to not found` 400. Production logs (12h
    // window, 363 reaction errors) showed three further buckets that
    // are equally unactionable but were still landing at ERROR:
    //   - 97x  HttpError "Network request for 'setMessageReaction' failed!"
    //   - 126x Grammy 400 "429: Too Many Requests: retry after N"
    //   - 96x  sendMessage "not enough rights to send …" (covered below)
    // Each bucket gets its own assertion so a future regression that
    // re-promotes one to ERROR fails specifically.
    it('downgrades transport-level HttpError to WARN (Grammy `Network request for ... failed!`)', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      currentBot().api.raw.setMessageReaction.mockRejectedValueOnce(
        new Error("Network request for 'setMessageReaction' failed!"),
      );
      await channel.sendReaction('tg:100200300', '485', '👍');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:100200300', messageId: '485' }),
        expect.stringContaining('Telegram reaction skipped'),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('downgrades Telegram 429 rate-limit responses to WARN', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      currentBot().api.raw.setMessageReaction.mockRejectedValueOnce(
        new Error(
          "Call to 'setMessageReaction' failed! (429: Too Many Requests: retry after 33)",
        ),
      );
      await channel.sendReaction('tg:100200300', '485', '👍');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:100200300', messageId: '485' }),
        expect.stringContaining('Telegram reaction skipped'),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('downgrades the production "message to react not found" string (no trailing "to") to WARN', async () => {
      // Telegram's actual 400 message body in the production logs is
      // "message to react not found" — no second "to". The original
      // regex `/message to react.*not found/i` matches both that and
      // the historical "message to react to not found" form. Pin the
      // exact production string so a future regex tightening can't
      // re-introduce the gap that originally fired 53 ERRORs / 12h.
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      currentBot().api.raw.setMessageReaction.mockRejectedValueOnce(
        new Error(
          "Call to 'setMessageReaction' failed! (400: Bad Request: message to react not found)",
        ),
      );
      await channel.sendReaction('tg:100200300', '485', '👍');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:100200300', messageId: '485' }),
        expect.stringContaining('Telegram reaction skipped'),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage transient-error downgrade ---

  describe('sendMessage transient-error handling', () => {
    // sendMessage's catch was logging EVERY failure at ERROR. The 12h
    // log window had 121 entries dominated by `not enough rights to
    // send text messages to the chat` (96, admin removed bot post
    // perm) and `Network request for 'sendMessage' failed!` (19,
    // transport blip). Neither is actionable mid-flight; both now
    // route through the shared `_isUnactionableTelegramError` gate.
    // `sendTelegramMessage` retries on HTML-mode failure WITHOUT
    // parse_mode (so a Markdown-with-bad-HTML message still goes
    // through). For these tests we want the BOTH calls to fail so the
    // outer catch in TelegramChannel.sendMessage runs — use the
    // persistent `mockRejectedValue` rather than `…Once`.
    it('downgrades "not enough rights to send" 400 to WARN', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      currentBot().api.sendMessage.mockRejectedValue(
        new Error(
          "Call to 'sendMessage' failed! (400: Bad Request: not enough rights to send text messages to the chat)",
        ),
      );
      await channel.sendMessage('tg:100200300', 'hello');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:100200300' }),
        expect.stringContaining('Telegram message dropped'),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('downgrades transport-level HttpError to WARN', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      currentBot().api.sendMessage.mockRejectedValue(
        new Error("Network request for 'sendMessage' failed!"),
      );
      await channel.sendMessage('tg:100200300', 'hello');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:100200300' }),
        expect.stringContaining('Telegram message dropped'),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('still logs at ERROR for unexpected sendMessage failures', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      currentBot().api.sendMessage.mockRejectedValue(
        new Error('Internal Server Error'),
      );
      await channel.sendMessage('tg:100200300', 'hello');
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:100200300' }),
        'Failed to send Telegram message',
      );
    });
  });

  // --- _isUnactionableTelegramError (helper, exported for tests) ---

  describe('_isUnactionableTelegramError', () => {
    // Pin every classified pattern from production logs so a future
    // refactor of the regex bouquet can't silently drop one.
    it.each([
      // bucket 1 — target gone / forbidden
      ['Bad Request: message to react not found'],
      ['Bad Request: message to react to not found'],
      ['Bad Request: message to be replied not found'],
      ['Bad Request: MESSAGE_ID_INVALID'],
      ['Bad Request: chat not found'],
      ['Forbidden: bot was blocked by the user'],
      ['Forbidden: bot was kicked from the supergroup chat'],
      ['Forbidden: user is deactivated'],
      // bucket 2 — perms changed
      ['Bad Request: not enough rights to send text messages to the chat'],
      // bucket 3 — rate limits
      ["Call to 'setMessageReaction' failed! (429: Too Many Requests: retry after 33)"],
      ["Call to 'sendMessage' failed! (429: Too Many Requests: retry after 5)"],
      // bucket 4 — transport
      ["Network request for 'setMessageReaction' failed!"],
      ["Network request for 'sendMessage' failed!"],
    ])('classifies %s as unactionable', async (msg) => {
      const { _isUnactionableTelegramError } = await import('./telegram.js');
      expect(_isUnactionableTelegramError(msg)).toBe(true);
    });

    it.each([
      // Genuine errors that SHOULD stay at ERROR.
      ['Internal Server Error'],
      ['ETIMEDOUT'],
      ['Bad Request: chat_id is empty'],
      ['Bad Request: PARSE_ENTITIES_FAILED'],
    ])('classifies %s as actionable (stays at ERROR)', async (msg) => {
      const { _isUnactionableTelegramError } = await import('./telegram.js');
      expect(_isUnactionableTelegramError(msg)).toBe(false);
    });
  });
});

// --- sendPoolMessage (module function) ---

describe('sendPoolMessage', () => {
  // The pool is module-level state, populated by `initBotPool()` with
  // real `grammy.Api` instances. Without that setup, `poolApis` is
  // empty — we exercise the empty-pool branch here, which exists for
  // exactly the case where the user hasn't configured any pool tokens.
  //
  // The contract that matters to callers (IPC handler) is the boolean
  // return value: `false` → IPC must skip `storeMessage`. Pre-fix this
  // function returned `Promise<void>`, leaving IPC no signal to gate
  // on, which is half of the production bug being fixed in this PR.
  it('returns false when no pool bots are configured', async () => {
    const result = await sendPoolMessage(
      'tg:100200300',
      'hello',
      'TestSender',
      'telegram_test-group',
    );
    expect(result).toBe(false);
  });
});
