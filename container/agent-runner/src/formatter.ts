import type { MessageInRow } from './db/messages-in.js';

/**
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
}

/**
 * Extract routing context from a batch of messages.
 * Uses the first message's routing fields.
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const first = messages[0];
  return {
    platformId: first?.platform_id ?? null,
    channelType: first?.channel_type ?? null,
    threadId: first?.thread_id ?? null,
    inReplyTo: first?.id ?? null,
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 */
export function formatMessages(messages: MessageInRow[]): string {
  if (messages.length === 0) return '';

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (taskMessages.length > 0) {
    parts.push(...taskMessages.map(formatTaskMessage));
  }
  if (webhookMessages.length > 0) {
    parts.push(...webhookMessages.map(formatWebhookMessage));
  }
  if (systemMessages.length > 0) {
    parts.push(...systemMessages.map(formatSystemMessage));
  }

  return parts.join('\n\n');
}

function formatChatMessages(messages: MessageInRow[]): string {
  if (messages.length === 1) {
    return formatSingleChat(messages[0]);
  }

  const lines = ['<messages>'];
  for (const msg of messages) {
    const content = parseContent(msg.content);
    const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
    const time = formatTime(msg.timestamp);
    const text = content.text || '';
    lines.push(`<message sender="${escapeXml(sender)}" time="${time}">${escapeXml(text)}</message>`);
  }
  lines.push('</messages>');
  return lines.join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
  const time = formatTime(msg.timestamp);
  const text = content.text || '';
  return `<message sender="${escapeXml(sender)}" time="${time}">${escapeXml(text)}</message>`;
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const parts = ['[SCHEDULED TASK]'];
  if (content.scriptOutput) {
    parts.push('', 'Script output:', JSON.stringify(content.scriptOutput, null, 2));
  }
  parts.push('', 'Instructions:', content.prompt || '');
  return parts.join('\n');
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  return `[WEBHOOK: ${source}/${event}]\n\n${JSON.stringify(content.payload || content, null, 2)}`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  return `[SYSTEM RESPONSE]\n\nAction: ${content.action || 'unknown'}\nStatus: ${content.status || 'unknown'}\nResult: ${JSON.stringify(content.result || null)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  } catch {
    return timestamp;
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
