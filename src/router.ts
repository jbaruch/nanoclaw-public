import { Channel, NewMessage } from './types.js';
import { parseTextStyles, ChannelType } from './text-styles.js';
import { formatLocalTime } from './timezone.js';
import { logger } from './logger.js';

const MAX_OUTBOUND_LENGTH = 50_000;

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const idAttr = m.id ? ` id="${escapeXml(m.id)}"` : '';
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message${idAttr} sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string, channel?: ChannelType): string {
  let text = stripInternalTags(rawText);
  if (!text) return '';
  if (text.length > MAX_OUTBOUND_LENGTH) {
    logger.warn(
      { originalLength: text.length },
      'Truncating oversized outbound message',
    );
    text = text.slice(0, MAX_OUTBOUND_LENGTH) + '\n\n[Message truncated]';
  }
  return channel ? parseTextStyles(text, channel) : text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<string | void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
