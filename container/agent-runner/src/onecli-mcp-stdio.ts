/**
 * OneCLI MCP — local stdio server that gives the agent structured access to
 * OneCLI-connected services via REST. All outbound HTTPS routes through the
 * OneCLI gateway (HTTPS_PROXY env) which transparently injects OAuth tokens.
 * No 3rd-party SDKs, no client secrets, no token juggling.
 *
 * This server hosts the Google integrations: Calendar (7 tools) + Gmail
 * (9 tools, draft CRUD only — no message send and no attachment download
 * in this revision). All tools are namespaced `onecli_*` so they can't
 * collide with another MCP (e.g. Composio) that exposes the same provider
 * under a different name.
 *
 * SmartThings has its own MCP server (onecli-smartthings-mcp-stdio.ts)
 * gated independently by NANOCLAW_ONECLI_ENABLE_SMARTTHINGS=1 — physical-
 * device writes are a different risk profile from read-mostly Google
 * services and shouldn't share an activation gate.
 *
 * Activation: agent-runner registers this server when
 * NANOCLAW_ONECLI_ENABLED=1 is set in the container env (the host-side
 * OneCLI proxy injection sets it alongside HTTPS_PROXY).
 */
import nodemailer from 'nodemailer';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';

// Default fetch timeout — anything over this and we abort. A hung gateway
// otherwise blocks the MCP request until the SDK's outer per-tool timeout,
// which is much longer and less informative.
const FETCH_TIMEOUT_MS = 45_000;

/**
 * Wrap fetch with an AbortController so a hung connection fails fast with
 * a clear message instead of stalling the entire turn.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strip the query string from a URL so error messages destined for
 * messages.db don't leak per-request PII (calendar IDs, thread IDs,
 * event IDs) into the conversation log. Full URL still goes to stderr
 * (`docker logs`) for debugging — that path is operator-private.
 */
function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Build an RFC 2822 MIME message + base64url encode for Gmail's drafts/messages
 * endpoints. Implementation delegates to nodemailer's stream transport so the
 * tricky parts (RFC 2047 header encoding for non-ASCII subjects/recipients,
 * line-folding, charset declarations, CRLF handling) come from a battle-
 * tested library rather than hand-rolled string concatenation.
 */
export async function encodeRfc2822Draft(args: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}): Promise<string> {
  // streamTransport + buffer:true with newline:'crlf' returns the fully
  // assembled MIME message as a Buffer in `info.message`. No SMTP, no
  // external connection — purely a MIME builder.
  const transporter = nodemailer.createTransport({
    streamTransport: true,
    newline: 'crlf',
    buffer: true,
  });
  const headers: Record<string, string> = {};
  if (args.inReplyTo) headers['In-Reply-To'] = args.inReplyTo;
  if (args.references) headers['References'] = args.references;
  const info = await transporter.sendMail({
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    text: args.body,
    headers: Object.keys(headers).length ? headers : undefined,
  });
  const raw = (info.message as Buffer).toString('utf-8');
  return Buffer.from(raw, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Node 20+ fetch honors HTTP(S)_PROXY / NO_PROXY env when NODE_USE_ENV_PROXY=1.
// OneCLI proxy env is set in the container by container-runner.ts for every
// trust tier; OAuth injection happens transparently. The trust tier itself
// gates which tools we register below — see UNTRUSTED_ALLOWLIST.

async function gapi(
  method: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetchWithTimeout(url, init);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    // User-visible error: strip query string so calendar/thread IDs
    // don't end up in messages.db. Full URL is on stderr already
    // (caller-side gapi.fetch logs); this just bounds what reaches
    // chat history.
    process.stderr.write(
      `[onecli-mcp] ${method} ${url} → ${res.status}\n`,
    );
    throw new Error(
      `${method} ${stripQuery(url)} → ${res.status}: ${
        typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
      }`,
    );
  }
  return parsed;
}

function ok(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      { type: 'text', text: JSON.stringify(data, null, 2) },
    ],
  };
}

const server = new McpServer({ name: 'onecli', version: '0.1.0' });

// Trust tier — set by container-runner via NANOCLAW_TRUST_TIER. When the
// container is untrusted, only a small allowlist of read-only, non-
// information-leaking tools gets exposed. Everything else (event titles,
// attendees, mail bodies, device commands, history) is held back.
//
// THREAT MODEL — read before trusting this gate:
//   The validator and the validated are the same process. We read
//   NANOCLAW_TRUST_TIER from `process.env`, but the agent-runner itself
//   is the same JS context that registers the tools — a sufficiently
//   determined agent could `delete process.env.NANOCLAW_TRUST_TIER`
//   before this module loads, or import it indirectly with a different
//   env. The gate works under the current threat model because:
//     1. Containers are spawned with `-e NANOCLAW_TRUST_TIER=...` set
//        by the orchestrator (src/container-runner.ts), which is the
//        only writer of the value at the host boundary.
//     2. Agents don't get arbitrary code execution inside the runner —
//        they communicate via the SDK's JSON message protocol, not by
//        injecting JS into the process.
//   IF either assumption changes (e.g. containers spawned with the env
//   unset OR a future hook lets agent code run outside the SDK
//   sandbox), this gate must move to a host-injected, agent-unreadable
//   mechanism (signed token, mounted file, separate process). Tracked
//   as a follow-up; do not remove this comment without updating the
//   threat model.
//
// Freebusy returns only {start, end} time pairs — no titles, attendees,
// or any event metadata — so it's the canonical "untrusted-safe"
// calendar primitive for letting other people query availability
// without learning what's actually scheduled.
//
// HARDENING — read before adding to this list:
//   * Any write tool MUST stay off this allowlist. Untrusted containers
//     are reachable from arbitrary chat senders; a write surface there
//     is privilege escalation, not a feature add. Calendar create /
//     update / delete and Gmail draft mutations all exist as separate
//     tools elsewhere in this file specifically because they can NEVER
//     be exposed to untrusted callers.
//   * Read tools that leak content (event titles, mail bodies, label
//     names) similarly must NOT be added — even read access to mail
//     bodies via an untrusted chat is a data exfiltration channel.
//   * `onecli_gcal_freebusy` is the only entry today. Adding entries
//     here changes the public-facing untrusted surface; treat it as a
//     security-policy edit, not a tool-listing edit.
const TRUST_TIER = (process.env.NANOCLAW_TRUST_TIER || 'untrusted').toLowerCase();
const UNTRUSTED_ALLOWLIST = new Set<string>([
  'onecli_gcal_freebusy',
]);

// Wrap registerTool so untrusted containers silently skip tools not on
// the allowlist. Single chokepoint — adding/removing a tool from the
// public untrusted surface is one line above, not 24 callsite edits.
const _origRegisterTool = server.registerTool.bind(server) as (
  ...args: unknown[]
) => unknown;
(server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool =
  (...args: unknown[]) => {
    const name = args[0] as string;
    if (TRUST_TIER === 'untrusted' && !UNTRUSTED_ALLOWLIST.has(name)) {
      return undefined;
    }
    return _origRegisterTool(...args);
  };

// ────────────────────────────────────────────────────────────────
// Google Calendar
// ────────────────────────────────────────────────────────────────

server.registerTool(
  'onecli_gcal_list_events',
  {
    title: 'List Calendar Events',
    description:
      'List upcoming events on a Google Calendar. Default calendar is "primary". Returns events sorted by start time.',
    inputSchema: {
      calendarId: z
        .string()
        .default('primary')
        .describe('Calendar ID — "primary" for the user\'s main calendar, or a specific ID from gcal_list_calendars.'),
      timeMin: z
        .string()
        .optional()
        .describe('RFC3339 lower bound (inclusive). Defaults to now.'),
      timeMax: z
        .string()
        .optional()
        .describe('RFC3339 upper bound (exclusive). If omitted, no upper bound.'),
      maxResults: z.number().int().min(1).max(250).default(25),
      q: z
        .string()
        .optional()
        .describe('Free-text search against summary/description/location/attendees.'),
    },
  },
  async ({ calendarId, timeMin, timeMax, maxResults, q }) => {
    const params = new URLSearchParams({
      maxResults: String(maxResults),
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: timeMin || new Date().toISOString(),
    });
    if (timeMax) params.set('timeMax', timeMax);
    if (q) params.set('q', q);
    const data = await gapi(
      'GET',
      `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    );
    return ok(data);
  },
);

server.registerTool(
  'onecli_gcal_get_event',
  {
    title: 'Get Calendar Event',
    description: 'Fetch full details of a specific calendar event.',
    inputSchema: {
      calendarId: z.string().default('primary'),
      eventId: z.string(),
    },
  },
  async ({ calendarId, eventId }) => {
    const data = await gapi(
      'GET',
      `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
    return ok(data);
  },
);

server.registerTool(
  'onecli_gcal_create_event',
  {
    title: 'Create Calendar Event',
    description:
      'Create a new event. start/end must be RFC3339 (e.g. "2026-04-25T10:00:00-07:00") for timed events, or {"date": "YYYY-MM-DD"} for all-day.',
    inputSchema: {
      calendarId: z.string().default('primary'),
      summary: z.string(),
      start: z
        .object({
          dateTime: z.string().optional(),
          date: z.string().optional(),
          timeZone: z.string().optional(),
        })
        .describe('Use dateTime for timed events, date for all-day.'),
      end: z.object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
        timeZone: z.string().optional(),
      }),
      location: z.string().optional(),
      description: z.string().optional(),
      attendees: z
        .array(z.object({ email: z.string(), optional: z.boolean().optional() }))
        .optional(),
      sendUpdates: z
        .enum(['all', 'externalOnly', 'none'])
        .default('none')
        .describe('Whether to email attendees.'),
    },
  },
  async ({ calendarId, sendUpdates, ...event }) => {
    const data = await gapi(
      'POST',
      `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${sendUpdates}`,
      event,
    );
    return ok(data);
  },
);

server.registerTool(
  'onecli_gcal_update_event',
  {
    title: 'Update Calendar Event',
    description:
      'PATCH an event (only send fields you want to change). Use gcal_get_event first if you need the current state.',
    inputSchema: {
      calendarId: z.string().default('primary'),
      eventId: z.string(),
      changes: z
        .record(z.string(), z.any())
        .describe('Partial event object — only the fields to update.'),
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).default('none'),
    },
  },
  async ({ calendarId, eventId, changes, sendUpdates }) => {
    const data = await gapi(
      'PATCH',
      `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
      changes,
    );
    return ok(data);
  },
);

server.registerTool(
  'onecli_gcal_delete_event',
  {
    title: 'Delete Calendar Event',
    description: 'Permanently delete an event.',
    inputSchema: {
      calendarId: z.string().default('primary'),
      eventId: z.string(),
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).default('none'),
    },
  },
  async ({ calendarId, eventId, sendUpdates }) => {
    await gapi(
      'DELETE',
      `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
    );
    return ok({ deleted: true, eventId });
  },
);

server.registerTool(
  'onecli_gcal_list_calendars',
  {
    title: 'List Calendars',
    description:
      'List all calendars the user has access to (primary + secondary + shared).',
    inputSchema: {},
  },
  async () => {
    const data = await gapi('GET', `${GCAL_BASE}/users/me/calendarList`);
    return ok(data);
  },
);

server.registerTool(
  'onecli_gcal_freebusy',
  {
    title: 'Query Free/Busy',
    description:
      'Check busy time windows across one or more calendars. Returns blocks, not event details.',
    inputSchema: {
      calendarIds: z
        .array(z.string())
        .default(['primary'])
        .describe('List of calendar IDs to query.'),
      timeMin: z.string().describe('RFC3339 start of window.'),
      timeMax: z.string().describe('RFC3339 end of window.'),
    },
  },
  async ({ calendarIds, timeMin, timeMax }) => {
    // Untrusted containers can only query the user's primary calendar.
    // Without this clamp, a participant in an untrusted group could ask
    // the bot to probe arbitrary calendar IDs (people's email addresses),
    // which Google would answer with freebusy data when the calendar is
    // shared with the user — leaking who-knows-whom information.
    const ids = TRUST_TIER === 'untrusted' ? ['primary'] : calendarIds;
    const data = await gapi('POST', `${GCAL_BASE}/freeBusy`, {
      timeMin,
      timeMax,
      items: ids.map((id) => ({ id })),
    });
    return ok(data);
  },
);

// ────────────────────────────────────────────────────────────────
// Gmail (read + drafts; NO direct send — user sends drafts manually in Gmail UI)
// ────────────────────────────────────────────────────────────────

server.registerTool(
  'onecli_gmail_search',
  {
    title: 'Search Gmail Messages',
    description:
      'Search the user\'s mailbox with Gmail query syntax (from:, to:, subject:, has:attachment, newer_than:7d, label:inbox, etc.). Returns message IDs + thread IDs; use gmail_get_message for full content.',
    inputSchema: {
      query: z.string().describe('Gmail search query (e.g. "from:boss@example.com is:unread").'),
      maxResults: z.number().int().min(1).max(100).default(20),
      labelIds: z
        .array(z.string())
        .optional()
        .describe('Restrict to specific labels (INBOX, SENT, STARRED, etc.).'),
    },
  },
  async ({ query, maxResults, labelIds }) => {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });
    if (labelIds) for (const id of labelIds) params.append('labelIds', id);
    const data = await gapi(
      'GET',
      `${GMAIL_BASE}/users/me/messages?${params}`,
    );
    return ok(data);
  },
);

server.registerTool(
  'onecli_gmail_get_message',
  {
    title: 'Get Gmail Message',
    description:
      'Fetch a specific message. format="full" returns headers + parsed body parts; "metadata" is headers only; "minimal" is just IDs and label list.',
    inputSchema: {
      id: z.string().describe('Message ID from gmail_search.'),
      format: z.enum(['full', 'metadata', 'minimal', 'raw']).default('full'),
    },
  },
  async ({ id, format }) => {
    const data = await gapi(
      'GET',
      `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(id)}?format=${format}`,
    );
    return ok(data);
  },
);

server.registerTool(
  'onecli_gmail_get_thread',
  {
    title: 'Get Gmail Thread',
    description:
      'Fetch a thread (conversation). Default returns metadata (headers + snippet per message) which is tiny and sufficient for overview. Use format="full" ONLY when you need message bodies and always paired with maxMessages to cap size — full threads with long history can overflow tool output limits. For a single message body, use gmail_get_message with that message id instead.',
    inputSchema: {
      id: z.string().describe('Thread ID (threadId from gmail_search or a message).'),
      format: z
        .enum(['full', 'metadata', 'minimal'])
        .default('metadata')
        .describe('metadata = headers + 200-char snippet (small); full = bodies (can be large); minimal = ids only.'),
      maxMessages: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Cap the number of most-recent messages returned. Older messages are dropped.'),
      bodyMaxChars: z
        .number()
        .int()
        .min(200)
        .max(10000)
        .default(2000)
        .describe('When format="full", truncate each message body to this many chars. Prevents giant threads from overflowing tool output.'),
    },
  },
  async ({ id, format, maxMessages, bodyMaxChars }) => {
    const data = (await gapi(
      'GET',
      `${GMAIL_BASE}/users/me/threads/${encodeURIComponent(id)}?format=${format}`,
    )) as { messages?: Array<Record<string, unknown>> };

    truncateThread(data, { maxMessages, bodyMaxChars, includeBodies: format === 'full' });

    return ok(data);
  },
);

/**
 * Trim a Gmail thread response to fit MCP-tool output budgets:
 *   - keep at most `maxMessages` (most-recent), drop earlier ones,
 *   - when `includeBodies` is true, truncate each base64-encoded body
 *     past `bodyMaxChars * 1.4` (the *.4 factor is the rough base64
 *     overhead — 100 plain chars become ~133 base64 chars, so a
 *     `bodyMaxChars=2000` cap on the *plaintext* corresponds to ~2800
 *     bytes of base64).
 *
 * Mutates `data` in place and stamps `_truncated` markers so the agent
 * can see what was dropped. Exported because the recursive walk on
 * `payload.parts` is the kind of code that breaks silently when
 * Gmail's response shape changes.
 */
export function truncateThread(
  data: { messages?: Array<Record<string, unknown>> } & Record<string, unknown>,
  opts: {
    maxMessages: number;
    bodyMaxChars: number;
    includeBodies: boolean;
  },
): void {
  if (data.messages && data.messages.length > opts.maxMessages) {
    const originalCount = data.messages.length;
    data.messages = data.messages.slice(-opts.maxMessages);
    data._truncated = {
      kept: opts.maxMessages,
      dropped: originalCount - opts.maxMessages,
      note: 'Only most-recent messages shown. Increase maxMessages to see more.',
    };
  }

  if (opts.includeBodies && Array.isArray(data.messages)) {
    const limit = Math.floor(opts.bodyMaxChars * 1.4);
    const truncatePart = (part: Record<string, unknown>): void => {
      const body = part.body as { data?: string; size?: number } | undefined;
      if (body?.data && typeof body.data === 'string') {
        if (body.data.length > limit) {
          body.data = body.data.slice(0, limit);
          (body as Record<string, unknown>)._truncated = true;
        }
      }
      const parts = part.parts as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(parts)) for (const sub of parts) truncatePart(sub);
    };
    for (const msg of data.messages) {
      const payload = msg.payload as Record<string, unknown> | undefined;
      if (payload) truncatePart(payload);
    }
  }
}

server.registerTool(
  'onecli_gmail_list_labels',
  {
    title: 'List Gmail Labels',
    description:
      'List all labels (system + user). Use the label IDs with gmail_search labelIds parameter.',
    inputSchema: {},
  },
  async () => {
    const data = await gapi('GET', `${GMAIL_BASE}/users/me/labels`);
    return ok(data);
  },
);

server.registerTool(
  'onecli_gmail_create_draft',
  {
    title: 'Create Gmail Draft',
    description:
      'Create a draft email the user can review and send manually. This tool does NOT send — it only drafts. Body is plain text UTF-8. For replies, use threadId + inReplyTo + references so the draft threads correctly.',
    inputSchema: {
      to: z.string().describe('Recipient(s), comma-separated.'),
      subject: z.string(),
      body: z.string().describe('Plain-text message body.'),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      threadId: z
        .string()
        .optional()
        .describe('Thread ID when replying to an existing thread.'),
      inReplyTo: z
        .string()
        .optional()
        .describe('RFC 2822 Message-ID header value of the message you\'re replying to.'),
      references: z
        .string()
        .optional()
        .describe('RFC 2822 References header value (space-separated Message-IDs) for proper threading.'),
    },
  },
  async ({ to, subject, body, cc, bcc, threadId, inReplyTo, references }) => {
    const raw = await encodeRfc2822Draft({
      to,
      subject,
      body,
      cc,
      bcc,
      inReplyTo,
      references,
    });
    const payload: Record<string, unknown> = { message: { raw } };
    if (threadId) (payload.message as Record<string, unknown>).threadId = threadId;
    const data = await gapi('POST', `${GMAIL_BASE}/users/me/drafts`, payload);
    return ok(data);
  },
);

server.registerTool(
  'onecli_gmail_update_draft',
  {
    title: 'Update Gmail Draft',
    description:
      'Replace the contents of an existing draft. Pass the new to/subject/body fully — this overwrites the draft, not a patch.',
    inputSchema: {
      draftId: z.string(),
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      threadId: z.string().optional(),
    },
  },
  async ({ draftId, to, subject, body, cc, bcc, threadId }) => {
    const raw = await encodeRfc2822Draft({ to, subject, body, cc, bcc });
    const payload: Record<string, unknown> = { message: { raw } };
    if (threadId) (payload.message as Record<string, unknown>).threadId = threadId;
    const data = await gapi(
      'PUT',
      `${GMAIL_BASE}/users/me/drafts/${encodeURIComponent(draftId)}`,
      payload,
    );
    return ok(data);
  },
);

server.registerTool(
  'onecli_gmail_list_drafts',
  {
    title: 'List Gmail Drafts',
    description: 'List existing drafts in the mailbox.',
    inputSchema: {
      maxResults: z.number().int().min(1).max(100).default(20),
      q: z.string().optional().describe('Optional Gmail query to filter drafts.'),
    },
  },
  async ({ maxResults, q }) => {
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (q) params.set('q', q);
    const data = await gapi('GET', `${GMAIL_BASE}/users/me/drafts?${params}`);
    return ok(data);
  },
);

server.registerTool(
  'onecli_gmail_get_draft',
  {
    title: 'Get Gmail Draft',
    description: 'Fetch a specific draft by ID, including its message content.',
    inputSchema: {
      draftId: z.string(),
      format: z.enum(['full', 'metadata', 'minimal']).default('full'),
    },
  },
  async ({ draftId, format }) => {
    const data = await gapi(
      'GET',
      `${GMAIL_BASE}/users/me/drafts/${encodeURIComponent(draftId)}?format=${format}`,
    );
    return ok(data);
  },
);

server.registerTool(
  'onecli_gmail_delete_draft',
  {
    title: 'Delete Gmail Draft',
    description: 'Permanently delete a draft.',
    inputSchema: {
      draftId: z.string(),
    },
  },
  async ({ draftId }) => {
    await gapi(
      'DELETE',
      `${GMAIL_BASE}/users/me/drafts/${encodeURIComponent(draftId)}`,
    );
    return ok({ deleted: true, draftId });
  },
);

// Intentionally NOT exposed:
//   • gmail_send (messages.send)    — user sends drafts manually.
//   • gmail_send_draft (drafts.send) — same reason.
//   • gmail_trash / gmail_modify    — destructive on received mail; out of scope.

// ────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[onecli-mcp] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
