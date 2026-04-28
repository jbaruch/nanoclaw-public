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
// Toggled to true only after we've verified the configured JID points
// at a 1:1 / DM chat. Stays false on misconfiguration so onAgentLine
// becomes a no-op and no thinking content leaks into a wrong chat.
let observerEnabledFlag = false;

export async function initObserver(
  channels: Channel[],
  registeredGroups: () => Record<string, RegisteredGroup>,
): Promise<void> {
  channelsRef = channels;
  registeredGroupsRef = registeredGroups;
  if (!OBSERVER_CHAT_JID) return;

  // Privacy gate: refuse to enable if OBSERVER_CHAT_JID points at a
  // multi-participant chat. The observer mirrors *all* containers'
  // thinking, tool-use, and partial output into this chat — accidentally
  // pointing it at a group with external members is a wholesale leak of
  // every conversation's reasoning. The env var IS the credential, so
  // we verify with the owning channel and refuse rather than fail open.
  const owner = channels.find(
    (c) => c.ownsJid(OBSERVER_CHAT_JID) && c.isConnected(),
  );
  if (!owner) {
    logger.error(
      { jid: OBSERVER_CHAT_JID },
      'Observer disabled: no connected channel owns the configured JID',
    );
    return;
  }
  if (!owner.isPrivateChat) {
    logger.error(
      { channel: owner.name, jid: OBSERVER_CHAT_JID },
      'Observer disabled: channel cannot verify chat is private — refusing to enable',
    );
    return;
  }
  let isPrivate: boolean;
  try {
    isPrivate = await owner.isPrivateChat(OBSERVER_CHAT_JID);
  } catch (err) {
    logger.error(
      { err, jid: OBSERVER_CHAT_JID },
      'Observer disabled: failed to verify chat type — refusing to enable',
    );
    return;
  }
  if (!isPrivate) {
    // Operator chose a non-private chat (group / channel). This IS a
    // leak surface — the observer mirrors thinking, tool-use, and
    // partial output from EVERY container, and any member of the
    // observer chat sees that stream. We allow it because some
    // operators run a deliberate "single-user private group" as the
    // observer (no third parties added). Loud warn at startup so the
    // misconfiguration is visible if it happens by accident.
    logger.warn(
      { jid: OBSERVER_CHAT_JID },
      'Observer chat is a group / channel, NOT a 1:1 DM. Anyone in the chat will see all containers reasoning. Use a chat with only the bot + you, or switch OBSERVER_CHAT_JID to a private DM.',
    );
  }
  observerEnabledFlag = true;
  logger.info({ jid: OBSERVER_CHAT_JID, isPrivate }, 'Observer chat enabled');
  armSelfTest();
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

// Reverse map cache for folderToChatJid. Rebuilt only when the
// registeredGroups dict identity changes (the orchestrator hands us a
// closure over the live dict, so identity equality is the cheapest
// invalidation signal). Avoids the per-thinking-block O(N) scan.
let cachedGroupsDict: Record<string, RegisteredGroup> | null = null;
let cachedFolderToJid: Map<string, string> = new Map();

function folderToChatJid(folder: string): string | undefined {
  if (!registeredGroupsRef) return undefined;
  const groups = registeredGroupsRef();
  if (groups !== cachedGroupsDict) {
    cachedFolderToJid = new Map();
    for (const [jid, g] of Object.entries(groups)) {
      cachedFolderToJid.set(g.folder, jid);
    }
    cachedGroupsDict = groups;
  }
  return cachedFolderToJid.get(folder);
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
// Liveness-only emojis — chosen so they DON'T overlap with the
// semantic states emitted from agent events: ⚡ (tool-use, except
// send_message) and ✍ (send_message in flight). Using ⚡ here would
// overwrite legitimate tool-fired state mid-query and leave the
// "tool" emoji stuck on the message after a long watchdog cycle even
// when the final state should have been ✍ (composed reply) or 🤔
// (thinking-only). 🫡 / 🆒 are both in TELEGRAM_ALLOWED_REACTIONS
// (see src/channels/telegram.ts) and read as "still on it" without
// claiming a particular semantic phase.
const BLINK_PAIR = ['🫡', '🆒'];
// Final reaction set when a query completes. The watchdog blink
// otherwise leaves whichever blink-emoji happened to be current on
// the user's message — unrelated to the actual end-state of the
// query. ✍ is what telegram.ts initially writes when send_message
// fires, but if no send_message ran (thinking-only or pure-text reply
// path) we still need a deterministic "done" emoji.
const DONE_REACTION = '🤝';

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
      // Threshold pings — once each. Restricted to the main chat:
      // posting "Still working — 60s in" into a shared trusted /
      // untrusted group is conversational noise for everyone *else*
      // in the chat (the people who didn't ask the bot anything),
      // and in untrusted contexts it also leaks "I'm grinding on
      // your prompt" before the agent's bad-actor-disengage rule
      // had a say. The blink reaction above stays for ALL chats
      // (it's just a reaction on the user's own message — no
      // broadcast surface). Threshold pings broadcast a new
      // message, so they go only where conversation is owner-only.
      const nextThreshold = PING_AT_SECONDS[w.pingsSent];
      if (nextThreshold && elapsedSec >= nextThreshold) {
        w.pingsSent++;
        const chatJid = folderToChatJid(source);
        const msgId = chatJid ? latestUserMessage.get(chatJid) : undefined;
        const groups = registeredGroupsRef?.();
        const isMainChat = chatJid && groups?.[chatJid]?.isMain === true;
        if (chatJid && msgId && isMainChat) {
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

function stopWatchdog(source: string, reactionOnStop?: string): void {
  const w = watchdogs.get(source);
  if (!w) return;
  clearInterval(w.intervalId);
  watchdogs.delete(source);
  // Reset the user's chat reaction so a stale 🫡/🆒 blink doesn't
  // outlive the watchdog. If the caller didn't pick a specific
  // emoji (e.g. mid-flight watchdog teardown to defuse a stale
  // entry), fall back to the deterministic done emoji.
  const target = reactionOnStop ?? DONE_REACTION;
  updateReaction(source, target);
}

export function observerEnabled(): boolean {
  return observerEnabledFlag;
}

// Self-test: if the observer is enabled but the agent-runner log
// format has drifted (or the orchestrator never spawned a query), we
// won't know — every onAgentLine call falls through silently.  Arm a
// one-shot watchdog after init: if no `Query input:` line lands
// within OBSERVER_SELF_TEST_MS, emit a single warning. That makes
// SDK-upgrade log-format breaks loud instead of letting the observer
// rot in place.
const OBSERVER_SELF_TEST_MS = 10 * 60 * 1000; // 10 minutes
let selfTestTimer: NodeJS.Timeout | null = null;
let sawAnyQueryInput = false;

function armSelfTest(): void {
  if (selfTestTimer) return;
  selfTestTimer = setTimeout(() => {
    if (!sawAnyQueryInput) {
      logger.warn(
        { graceMs: OBSERVER_SELF_TEST_MS },
        'Observer enabled but no `Query input:` lines parsed — agent-runner log format may have drifted; check container/agent-runner output',
      );
    }
    selfTestTimer = null;
  }, OBSERVER_SELF_TEST_MS);
  // Don't keep the event loop alive purely for this timer.
  selfTestTimer.unref?.();
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
    const body =
      parts.length > 1 ? `${part} (${idx + 1}/${parts.length})` : part;
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
    sawAnyQueryInput = true;
    states.set(source, newState());
    // Defuse any watchdog left over from a prior query that crashed
    // before emitting `Query done.` (SDK exception, agent-runner kill,
    // container OOM). Without this, the second query would see
    // `watchdogs.has(source) === true`, skip startWatchdog, and inherit
    // a stale `startedAt` / `pingsSent` — threshold pings would
    // misfire instantly. Pass undefined so the reset uses the
    // deterministic done emoji rather than the new query's not-yet-
    // established state.
    stopWatchdog(source);
    // A new query is starting — the 👀 reaction from telegram.ts is already
    // on the message. Don't pre-emptively change it; the first thinking/tool
    // event will swap to 🤔/🔧 naturally.
    //
    // Don't arm the watchdog for scheduled tasks. Cron-driven queries
    // (SmartThings refresh, check-unanswered, heartbeat, etc.) run in
    // maintenance containers but share the source folder with the user's
    // default container. Without this gate, a long cron task crossing 120s
    // fires "Still working — 120s in" into the user's chat — looking like
    // the user's last message is still being processed when actually the
    // user's query finished minutes ago and a separate cron is running.
    // The agent-runner logs scheduled tasks with a `[SCHEDULED TASK -` or
    // `<untrusted-input source=…> [SCHEDULED TASK -` prefix in the
    // preview; match either form.
    const isScheduledTask =
      /preview="(?:<untrusted-input source="[^"]*">\s*)?\[SCHEDULED TASK/.test(
        line,
      );
    if (!isScheduledTask) {
      startWatchdog(source);
    }
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
    // Pick the deterministic end-state emoji. ✍ if the agent ended on
    // a send_message (composed reply landed); otherwise fall through
    // to stopWatchdog's DONE_REACTION default. We deliberately don't
    // try to reproduce ⚡ — a watchdog blink could already have
    // overwritten that, and "tool fired" isn't a stable end-state.
    // toolCalls stores names with the `mcp__<server>__` prefix already
    // stripped (see normalization in the tool_use branch above).
    const lastTool = state.toolCalls[state.toolCalls.length - 1];
    const doneEmoji = lastTool === 'send_message' ? '✍' : undefined;
    stopWatchdog(source, doneEmoji);
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
