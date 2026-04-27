/**
 * Agent activity observer — optional forwarder that sends per-query summaries
 * and live error alerts to a dedicated Telegram "observer" chat, parsing the
 * agent-runner's stderr lines that container-runner already emits as debug logs.
 *
 * Enable by setting `OBSERVER_CHAT_JID=tg:-100...` in .env or the plist.
 */
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import type { Channel, RegisteredGroup } from './types.js';

const OBSERVER_CHAT_JID =
  process.env.OBSERVER_CHAT_JID ||
  readEnvFile(['OBSERVER_CHAT_JID']).OBSERVER_CHAT_JID;

let channelsRef: Channel[] | null = null;
let registeredGroupsRef: (() => Record<string, RegisteredGroup>) | null = null;

export function initObserver(
  channels: Channel[],
  registeredGroups: () => Record<string, RegisteredGroup>,
): void {
  channelsRef = channels;
  registeredGroupsRef = registeredGroups;
  if (OBSERVER_CHAT_JID) {
    logger.info({ jid: OBSERVER_CHAT_JID }, 'Observer chat enabled');
  }
}

// Progress-reaction state: track the latest user message per chat so
// container-stderr-driven events can update the reaction on the right
// message as work unfolds. Also remember the last emoji we set, so we
// don't spam the Telegram API with identical reactions.
const latestUserMessage = new Map<string, string>(); // chatJid -> messageId
const lastReactionEmoji = new Map<string, string>(); // chatJid -> emoji

export function noteLatestUserMessage(
  chatJid: string,
  messageId: string,
): void {
  latestUserMessage.set(chatJid, messageId);
  // 👀 is the initial reaction written by the telegram handler; record it
  // so subsequent updates don't no-op waiting for a different emoji.
  lastReactionEmoji.set(chatJid, '👀');
}

function folderToChatJid(folder: string): string | undefined {
  if (!registeredGroupsRef) return undefined;
  const groups = registeredGroupsRef();
  for (const [jid, g] of Object.entries(groups)) {
    if (g.folder === folder) return jid;
  }
  return undefined;
}

function updateReaction(folder: string, emoji: string): void {
  if (!channelsRef) return;
  const chatJid = folderToChatJid(folder);
  if (!chatJid) return;
  const msgId = latestUserMessage.get(chatJid);
  if (!msgId) return;
  if (lastReactionEmoji.get(chatJid) === emoji) return; // dedupe
  lastReactionEmoji.set(chatJid, emoji);
  const channel = channelsRef.find(
    (c) => c.ownsJid(chatJid) && c.isConnected() && c.sendReaction,
  );
  if (!channel?.sendReaction) return;
  channel.sendReaction(chatJid, msgId, emoji).catch((err: unknown) => {
    logger.debug(
      { err, chatJid, msgId, emoji },
      'Observer reaction update failed',
    );
  });
}

// Liveness watchdog: long queries with no chat output look like the bot
// hung. We blink the reaction emoji and, past a longer threshold, post a
// terse "still working" message to the user's chat so they know it's alive.
interface Watchdog {
  intervalId: NodeJS.Timeout;
  startedAt: number;
  pingsSent: number;
  lastBlinkEmoji: string;
}
const watchdogs = new Map<string, Watchdog>(); // source -> watchdog

const BLINK_INTERVAL_MS = 30_000;
const PING_AT_SECONDS = [60, 120, 300]; // 1m, 2m, 5m
const BLINK_PAIR = ['⚡', '🔥'];

function chatChannel(chatJid: string): Channel | undefined {
  return channelsRef?.find((c) => c.ownsJid(chatJid) && c.isConnected());
}

function startWatchdog(source: string): void {
  if (watchdogs.has(source)) return;
  const startedAt = Date.now();
  const w: Watchdog = {
    startedAt,
    pingsSent: 0,
    lastBlinkEmoji: BLINK_PAIR[0],
    intervalId: setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      // Blink reaction
      const next =
        w.lastBlinkEmoji === BLINK_PAIR[0] ? BLINK_PAIR[1] : BLINK_PAIR[0];
      w.lastBlinkEmoji = next;
      updateReaction(source, next);
      // Threshold pings — once each
      const nextThreshold = PING_AT_SECONDS[w.pingsSent];
      if (nextThreshold && elapsedSec >= nextThreshold) {
        w.pingsSent++;
        const chatJid = folderToChatJid(source);
        const msgId = chatJid ? latestUserMessage.get(chatJid) : undefined;
        if (chatJid && msgId) {
          const ch = chatChannel(chatJid);
          const state = states.get(source);
          const toolCount = state?.toolCalls.length ?? 0;
          const text = `<i>Still working — ${elapsedSec}s in${toolCount ? `, ${toolCount} tools so far` : ''}.</i>`;
          ch?.sendMessage(chatJid, text, msgId).catch((err) =>
            logger.debug({ err }, 'Watchdog ping failed'),
          );
        }
      }
    }, BLINK_INTERVAL_MS),
  };
  watchdogs.set(source, w);
}

function stopWatchdog(source: string): void {
  const w = watchdogs.get(source);
  if (!w) return;
  clearInterval(w.intervalId);
  watchdogs.delete(source);
}

export function observerEnabled(): boolean {
  return !!OBSERVER_CHAT_JID;
}

interface QueryState {
  startTime: number;
  thinkingCount: number;
  toolCalls: string[]; // flattened list; we count duplicates at flush
  toolErrors: number;
  textSnippets: string[];
  stopReason?: string;
}

// Keyed by container/group folder; one slot per concurrent query.
const states = new Map<string, QueryState>();

function newState(): QueryState {
  return {
    startTime: Date.now(),
    thinkingCount: 0,
    toolCalls: [],
    toolErrors: 0,
    textSnippets: [],
  };
}

// Telegram caps messages at 4096 chars; leave headroom for any HTML the
// channel layer may add and for our own continuation marker.
const OBSERVER_CHUNK_SIZE = 3800;

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    // Try to break at the nearest whitespace within the last 200 chars
    // so we don't cut a word in half. If no whitespace found, hard-cut.
    if (end < text.length) {
      const slack = text.lastIndexOf(' ', end);
      if (slack > i + size - 200) end = slack;
    }
    chunks.push(text.slice(i, end));
    i = end;
    while (i < text.length && text[i] === ' ') i++;
  }
  return chunks;
}

function send(text: string): void {
  if (!OBSERVER_CHAT_JID || !channelsRef) return;
  const channel = channelsRef.find(
    (c) => c.ownsJid(OBSERVER_CHAT_JID) && c.isConnected(),
  );
  if (!channel) {
    logger.warn({ jid: OBSERVER_CHAT_JID }, 'Observer: no channel owns JID');
    return;
  }
  const parts = chunkText(text, OBSERVER_CHUNK_SIZE);
  // Send sequentially so chunks land in order. Failure on any chunk is
  // logged but does not abort the rest — partial visibility beats none.
  let chain: Promise<unknown> = Promise.resolve();
  parts.forEach((part, idx) => {
    const body = parts.length > 1 ? `${part} (${idx + 1}/${parts.length})` : part;
    chain = chain.then(() =>
      channel.sendMessage(OBSERVER_CHAT_JID, body).catch((err: unknown) => {
        logger.warn(
          { err, jid: OBSERVER_CHAT_JID, chunk: idx + 1, of: parts.length },
          'Observer send failed',
        );
      }),
    );
  });
}

/**
 * Feed one stderr line from the agent-runner. Parses known patterns and
 * accumulates per-source state. Returns silently for unrecognized lines.
 */
export function onAgentLine(source: string, raw: string): void {
  if (!observerEnabled()) return;

  // Strip the "[agent-runner] " prefix if present — makes the regexes simpler.
  const line = raw.replace(/^\[agent-runner\]\s*/, '');

  // Query boundaries
  if (line.startsWith('Query input:')) {
    states.set(source, newState());
    // A new query is starting — the 👀 reaction from telegram.ts is already
    // on the message. Don't pre-emptively change it; the first thinking/tool
    // event will swap to 🤔/🔧 naturally.
    startWatchdog(source);
    return;
  }

  const state = states.get(source);
  if (!state) return;

  // Thinking block — count AND live-stream the full content so you can
  // watch the agent's reasoning unfold in real time. The agent-runner emits
  // the full thinking text on a single log line (whitespace collapsed); the
  // chunker in send() splits anything over Telegram's 4096-char cap.
  const thinkingMatch = line.match(/^\[msg #\d+\] thinking="(.*)"$/);
  if (thinkingMatch) {
    state.thinkingCount++;
    send(`🧠 [${source}] ${thinkingMatch[1]}`);
    updateReaction(source, '🤔');
    return;
  }

  // Tool use
  const toolUse = line.match(/^\[msg #\d+\] tool_use=(\S+)/);
  if (toolUse) {
    // Normalize "mcp__onecli__gmail_search" → "gmail_search" for readability
    const name = toolUse[1].replace(/^mcp__[^_]+__/, '');
    state.toolCalls.push(name);
    // mcp__nanoclaw__send_message means the agent is DELIVERING, not doing
    // more work — show the "composing" emoji instead of the "working"
    // emoji so the user sees progress: thinking → working → composing.
    //
    // IMPORTANT: these must all be in TELEGRAM_ALLOWED_REACTIONS in
    // src/channels/telegram.ts. Telegram limits bot reactions to a fixed
    // set; anything else silently falls back to 👍 and defeats the signal.
    // ⚡ is the closest "busy/working" emoji in the allowed set.
    updateReaction(
      source,
      toolUse[1] === 'mcp__nanoclaw__send_message' ? '✍' : '⚡',
    );
    return;
  }

  // Tool result — capture status + live-alert on errors
  const toolResult = line.match(
    /^\[msg #\d+\] tool_result id=\S+ (ok|error)(?: latency=(\d+)ms)?/,
  );
  if (toolResult) {
    if (toolResult[1] === 'error') {
      state.toolErrors++;
      // Live alert — unclipped line, truncated for Telegram sanity
      send(`❌ [${source}] ${line.slice(0, 800)}`);
    }
    return;
  }

  // Final user-facing text
  const textMatch = line.match(/^\[msg #\d+\] text="([^"]*)"/);
  if (textMatch) {
    state.textSnippets.push(textMatch[1]);
    return;
  }

  // Stop reason is on the "assistant blocks=..." header line
  const stopMatch = line.match(
    /^\[msg #\d+\] assistant blocks=\[[^\]]*\] stop=(\S+)/,
  );
  if (stopMatch) {
    state.stopReason = stopMatch[1];
    return;
  }

  // Query done — stop the liveness watchdog and flush summary
  if (line.startsWith('Query done.')) {
    stopWatchdog(source);
    const wall = /wall=(\d+)ms/.exec(line)?.[1];
    const tokIn = /tokens_in=(\d+)/.exec(line)?.[1];
    const tokOut = /tokens_out=(\d+)/.exec(line)?.[1];
    const cacheHit = /cache_hit_rate=([0-9.]+|n\/a)/.exec(line)?.[1];
    flushSummary(source, state, {
      wall: wall ? parseInt(wall, 10) : undefined,
      tokIn: tokIn ? parseInt(tokIn, 10) : undefined,
      tokOut: tokOut ? parseInt(tokOut, 10) : undefined,
      cacheHit,
    });
    states.delete(source);
    return;
  }
}

function flushSummary(
  source: string,
  state: QueryState,
  metrics: {
    wall?: number;
    tokIn?: number;
    tokOut?: number;
    cacheHit?: string;
  },
): void {
  // Roll up tool calls: ["gcal_list", "gmail_search", "gmail_search"] → "gcal_list, gmail_search×2"
  const counts: Record<string, number> = {};
  for (const name of state.toolCalls) counts[name] = (counts[name] || 0) + 1;
  const toolLine =
    Object.keys(counts).length === 0
      ? '(none)'
      : Object.entries(counts)
          .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
          .join(', ');

  const wallSec = metrics.wall ? (metrics.wall / 1000).toFixed(1) : '?';
  const errPart = state.toolErrors > 0 ? ` | ❌ ${state.toolErrors} err` : '';
  const stopPart = state.stopReason ? ` stop=${state.stopReason}` : '';

  const lines = [
    `📊 [${source}]`,
    `🧠 ${state.thinkingCount} thinking | 🔧 ${state.toolCalls.length} tools: ${toolLine}${errPart}`,
    `⏱ ${wallSec}s | in=${metrics.tokIn ?? '?'} out=${metrics.tokOut ?? '?'} | cache=${metrics.cacheHit ?? '?'}%${stopPart}`,
  ];

  if (state.textSnippets.length > 0) {
    const last = state.textSnippets[state.textSnippets.length - 1];
    lines.push(`💬 "${last.slice(0, 160)}${last.length > 160 ? '…' : ''}"`);
  }

  send(lines.join('\n'));
}
