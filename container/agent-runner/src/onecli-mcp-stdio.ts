/**
 * OneCLI MCP — local stdio server that gives the agent structured access to
 * OneCLI-connected Google services via REST. All outbound HTTPS is routed
 * through the OneCLI gateway (HTTPS_PROXY env) which transparently injects
 * OAuth tokens. No 3rd-party SDKs, no client secrets, no token juggling.
 *
 * Tools are Google Calendar today; Gmail/Drive/etc can be added as OneCLI
 * connects more apps.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';

/**
 * Build an RFC 2822 MIME message + base64url encode for Gmail's drafts/messages
 * endpoints. Bare-minimum headers — Gmail fills in Date, Message-ID, From.
 */
function encodeRfc2822Draft(args: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers: string[] = [`To: ${args.to}`];
  if (args.cc) headers.push(`Cc: ${args.cc}`);
  if (args.bcc) headers.push(`Bcc: ${args.bcc}`);
  headers.push(`Subject: ${args.subject}`);
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references) headers.push(`References: ${args.references}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  const raw = headers.join('\r\n') + '\r\n\r\n' + args.body;
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
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${url} → ${res.status}: ${
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
// Freebusy returns only {start, end} time pairs — no titles, attendees,
// or any event metadata — so it's the canonical "untrusted-safe"
// calendar primitive for letting other people query availability
// without learning what's actually scheduled.
const TRUST_TIER = (process.env.NANOCLAW_TRUST_TIER || 'untrusted').toLowerCase();
const UNTRUSTED_ALLOWLIST = new Set<string>([
  'gcal_freebusy',
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
  'gcal_list_events',
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
  'gcal_get_event',
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
  'gcal_create_event',
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
  'gcal_update_event',
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
  'gcal_delete_event',
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
  'gcal_list_calendars',
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
  'gcal_freebusy',
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
  'gmail_search',
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
  'gmail_get_message',
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
  'gmail_get_thread',
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

    if (data.messages && data.messages.length > maxMessages) {
      const originalCount = data.messages.length;
      data.messages = data.messages.slice(-maxMessages);
      (data as Record<string, unknown>)._truncated = {
        kept: maxMessages,
        dropped: originalCount - maxMessages,
        note: 'Only most-recent messages shown. Increase maxMessages to see more.',
      };
    }

    if (format === 'full' && Array.isArray(data.messages)) {
      // Walk payload.parts recursively and truncate text bodies.
      const truncatePart = (part: Record<string, unknown>): void => {
        const body = part.body as
          | { data?: string; size?: number }
          | undefined;
        if (body?.data && typeof body.data === 'string') {
          // Gmail bodies are base64url-encoded. Only truncate if large.
          if (body.data.length > bodyMaxChars * 1.4) {
            body.data = body.data.slice(0, Math.floor(bodyMaxChars * 1.4));
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

    return ok(data);
  },
);

server.registerTool(
  'gmail_list_labels',
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
  'gmail_create_draft',
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
    const raw = encodeRfc2822Draft({
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
  'gmail_update_draft',
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
    const raw = encodeRfc2822Draft({ to, subject, body, cc, bcc });
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
  'gmail_list_drafts',
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
  'gmail_get_draft',
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
  'gmail_delete_draft',
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
// SmartThings — devices, scenes, locations. Auth via OneCLI generic
// secret on `api.smartthings.com`, header=Authorization, format=Bearer
// {value}. The Authorization header below is just a placeholder; OneCLI
// overwrites it with the real Personal Access Token on the wire.
// ────────────────────────────────────────────────────────────────

const ST_BASE = 'https://api.smartthings.com/v1';
const ST_AUTH = 'Bearer placeholder-via-onecli';

async function st(
  method: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: { Authorization: ST_AUTH },
  };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] =
      'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${url} → ${res.status}: ${
        typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
      }`,
    );
  }
  return parsed;
}

server.registerTool(
  'smartthings_list_devices',
  {
    title: 'List SmartThings Devices',
    description:
      'List all devices on the user\'s SmartThings hub — lights, switches, thermostats, sensors, locks, etc. Use this to find a device id before calling get_status or send_command. Includes Hue lights linked through the SmartThings → Hue integration.',
    inputSchema: {
      locationId: z.string().optional().describe('Filter to a single location.'),
      capability: z
        .string()
        .optional()
        .describe(
          'Filter by capability (e.g. "switch", "switchLevel", "thermostatSetpoint", "lock", "motionSensor").',
        ),
    },
  },
  async ({ locationId, capability }) => {
    const params = new URLSearchParams();
    if (locationId) params.set('locationId', locationId);
    if (capability) params.set('capability', capability);
    const qs = params.toString();
    const data = (await st(
      'GET',
      `${ST_BASE}/devices${qs ? '?' + qs : ''}`,
    )) as { items?: Array<Record<string, unknown>> };
    // Slim down the response — full device records have a lot of noise.
    const items = (data.items || []).map((d) => ({
      deviceId: d.deviceId,
      name: d.label || d.name,
      manufacturer: (d as { manufacturerName?: string }).manufacturerName,
      type: d.type,
      locationId: d.locationId,
      roomId: d.roomId,
      capabilities: ((d.components as Array<{ capabilities?: Array<{ id: string }> }>) || [])
        .flatMap((c) => (c.capabilities || []).map((cap) => cap.id)),
    }));
    return ok({ count: items.length, items });
  },
);

server.registerTool(
  'smartthings_get_device_status',
  {
    title: 'Get SmartThings Device Status',
    description:
      'Read the current state of a device — e.g. is the light on, what level, what temperature, locked or unlocked. Returns the full attribute map across all components/capabilities.',
    inputSchema: { deviceId: z.string() },
  },
  async ({ deviceId }) => {
    const data = await st(
      'GET',
      `${ST_BASE}/devices/${encodeURIComponent(deviceId)}/status`,
    );
    return ok(data);
  },
);

server.registerTool(
  'smartthings_send_command',
  {
    title: 'Send SmartThings Command',
    description:
      'Send a command to a device. Examples: turn a light on (`switch`/`on`), dim to 50% (`switchLevel`/`setLevel`/[50]), set thermostat to 70F (`thermostatCoolingSetpoint`/`setCoolingSetpoint`/[70]), unlock (`lock`/`unlock`). Use list_devices to get capabilities for a device, and SmartThings docs for capability/command/args reference.',
    inputSchema: {
      deviceId: z.string(),
      capability: z.string().describe('Capability id, e.g. "switch", "switchLevel".'),
      command: z.string().describe('Command name, e.g. "on", "setLevel".'),
      arguments: z
        .array(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Command arguments (positional, e.g. [50] for setLevel).'),
      component: z
        .string()
        .default('main')
        .describe('Device component, almost always "main".'),
    },
  },
  async ({ deviceId, capability, command, arguments: args, component }) => {
    const data = await st(
      'POST',
      `${ST_BASE}/devices/${encodeURIComponent(deviceId)}/commands`,
      {
        commands: [
          {
            component,
            capability,
            command,
            arguments: args || [],
          },
        ],
      },
    );
    return ok(data);
  },
);

server.registerTool(
  'smartthings_list_scenes',
  {
    title: 'List SmartThings Scenes',
    description:
      'List all scenes the user has configured. Scenes are pre-built device groupings ("Movie Time", "Bedtime") that change multiple devices at once.',
    inputSchema: {
      locationId: z.string().optional(),
    },
  },
  async ({ locationId }) => {
    const params = new URLSearchParams();
    if (locationId) params.set('locationId', locationId);
    const qs = params.toString();
    const data = await st(
      'GET',
      `${ST_BASE}/scenes${qs ? '?' + qs : ''}`,
    );
    return ok(data);
  },
);

server.registerTool(
  'smartthings_execute_scene',
  {
    title: 'Execute SmartThings Scene',
    description:
      'Trigger a scene. Best UX for "set the lights for a movie", "good night" — instead of orchestrating multiple device commands, the user already grouped them.',
    inputSchema: { sceneId: z.string() },
  },
  async ({ sceneId }) => {
    const data = await st(
      'POST',
      `${ST_BASE}/scenes/${encodeURIComponent(sceneId)}/execute`,
      {},
    );
    return ok(data);
  },
);

server.registerTool(
  'smartthings_get_history',
  {
    title: 'Get SmartThings Device Event History',
    description:
      'Fetch device event history (when motion was detected, when a switch was flipped, when a door was opened, etc). Use to answer "did anyone walk by the front door yesterday?" or "what time did the bedroom lights go off?" or "did anyone come home in the last hour?". Each event has timestamp, device, capability, attribute, and value. The response includes a `nextPage` cursor object — pass it back as `nextPage` to fetch the page before the oldest event in this batch (history goes backwards in time when oldestFirst=false). Repeat until `nextPage` is null or you have enough.',
    inputSchema: {
      locationId: z
        .string()
        .describe(
          'Location id (required). Get from list_locations — most users have one.',
        ),
      deviceId: z.string().optional().describe('Filter to a single device.'),
      limit: z.number().int().min(1).max(200).default(50),
      oldestFirst: z
        .boolean()
        .default(false)
        .describe('Default false = newest events first.'),
      nextPage: z
        .object({
          epoch: z.number(),
          hash: z.number(),
        })
        .optional()
        .describe(
          'Pagination cursor returned from a previous call (`nextPage` field). Pass verbatim to walk further back in time. Omit on first call.',
        ),
    },
  },
  async ({ locationId, deviceId, limit, oldestFirst, nextPage }) => {
    const params = new URLSearchParams({
      locationId,
      limit: String(limit),
      oldestFirst: String(oldestFirst),
    });
    if (deviceId) params.set('deviceId', deviceId);
    // SmartThings cursor uses two query params together; both required.
    if (nextPage) {
      params.set('pagingBeforeEpoch', String(nextPage.epoch));
      params.set('pagingBeforeHash', String(nextPage.hash));
    }
    const data = (await st(
      'GET',
      `${ST_BASE}/history/devices?${params}`,
    )) as {
      items?: Array<Record<string, unknown>>;
      _links?: { next?: { href?: string } };
    };
    // Slim event records — full responses include translated metadata,
    // hashes, and other fields the agent rarely needs. Keep what's useful
    // for "tell me what happened."
    const items = (data.items || []).map((e) => ({
      time: e.time,
      device: e.deviceName,
      deviceId: e.deviceId,
      text: e.text,
      capability: e.capability,
      attribute: e.attribute,
      value: e.value,
      unit: e.unit,
    }));
    // Extract a clean cursor object from the API's `_links.next.href`
    // query string (epoch + hash). null when there are no older events.
    let cursor: { epoch: number; hash: number } | null = null;
    const nextHref = data._links?.next?.href;
    if (nextHref) {
      try {
        const u = new URL(nextHref);
        const e = u.searchParams.get('pagingBeforeEpoch');
        const h = u.searchParams.get('pagingBeforeHash');
        if (e && h) cursor = { epoch: Number(e), hash: Number(h) };
      } catch {
        /* ignore — leave cursor null */
      }
    }
    return ok({ count: items.length, items, nextPage: cursor });
  },
);

server.registerTool(
  'smartthings_list_locations',
  {
    title: 'List SmartThings Locations',
    description:
      'List the user\'s SmartThings locations (homes / properties). Most users have one. Use the locationId to filter device/scene/room calls.',
    inputSchema: {},
  },
  async () => {
    const data = await st('GET', `${ST_BASE}/locations`);
    return ok(data);
  },
);

server.registerTool(
  'smartthings_list_rooms',
  {
    title: 'List SmartThings Rooms',
    description:
      'List rooms in a SmartThings location. Combine with list_devices to filter by room (devices have roomId).',
    inputSchema: { locationId: z.string() },
  },
  async ({ locationId }) => {
    const data = await st(
      'GET',
      `${ST_BASE}/locations/${encodeURIComponent(locationId)}/rooms`,
    );
    return ok(data);
  },
);

// ────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[onecli-mcp] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
