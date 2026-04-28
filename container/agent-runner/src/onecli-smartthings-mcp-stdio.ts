/**
 * OneCLI SmartThings MCP — separate stdio server for SmartThings access via
 * the OneCLI gateway. Lives apart from the Calendar/Gmail server because:
 *
 *   - Risk profile: SmartThings tools mutate physical state (lights,
 *     locks, thermostats, scenes). Calendar/Gmail are read-mostly with
 *     bounded blast radius (a stray draft is an embarrassment, not an
 *     unlocked door). Operators who want gcal_* shouldn't be forced to
 *     also expose 8 device-write tools.
 *   - Independent activation: gated on
 *     NANOCLAW_ONECLI_ENABLE_SMARTTHINGS=1 in addition to the umbrella
 *     NANOCLAW_ONECLI_ENABLED=1. Both must be set.
 *
 * Auth: OneCLI generic secret on `api.smartthings.com` with
 * header=Authorization, format=Bearer {value}. The header below is just
 * a placeholder; OneCLI overwrites it with the real Personal Access
 * Token on the wire.
 *
 * Trust gate: same NANOCLAW_TRUST_TIER mechanism as the sibling server.
 * Untrusted containers don't get *any* SmartThings tools registered —
 * the entire surface is trusted/main-only. This is enforced here
 * (UNTRUSTED_REGISTRATION_BLOCKED) AND should be enforced by the
 * agent-runner not even spawning this server when trust=untrusted.
 * Defense in depth.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ST_BASE = 'https://api.smartthings.com/v1';
const ST_AUTH = 'Bearer placeholder-via-onecli';

const FETCH_TIMEOUT_MS = 45_000;

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

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

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
  const res = await fetchWithTimeout(url, init);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    process.stderr.write(
      `[onecli-smartthings-mcp] ${method} ${url} → ${res.status}\n`,
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
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

const server = new McpServer({
  name: 'onecli-smartthings',
  version: '0.1.0',
});

// HARDENING: SmartThings tools that mutate physical state
// (smartthings_send_command and smartthings_execute_scene) must NEVER
// be added to an untrusted-allowlist. They turn into a "remote control"
// surface for whoever can talk to an untrusted container — a very
// different threat than data leakage. Adding a write tool to any future
// untrusted-mode allowlist is a privilege escalation, not a feature
// add. There is intentionally no allowlist in this file; if untrusted
// support is ever added, every tool here MUST stay off it.
const TRUST_TIER = (
  process.env.NANOCLAW_TRUST_TIER || 'untrusted'
).toLowerCase();
const UNTRUSTED_REGISTRATION_BLOCKED = TRUST_TIER === 'untrusted';

const _origRegisterTool = server.registerTool.bind(server) as (
  ...args: unknown[]
) => unknown;
(
  server as unknown as { registerTool: (...args: unknown[]) => unknown }
).registerTool = (...args: unknown[]) => {
  if (UNTRUSTED_REGISTRATION_BLOCKED) {
    return undefined;
  }
  return _origRegisterTool(...args);
};

server.registerTool(
  'onecli_smartthings_list_devices',
  {
    title: 'List SmartThings Devices',
    description:
      "List all devices on the user's SmartThings hub — lights, switches, thermostats, sensors, locks, etc. Use this to find a device id before calling get_status or send_command. Includes Hue lights linked through the SmartThings → Hue integration.",
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
    const items = (data.items || []).map((d) => ({
      deviceId: d.deviceId,
      name: d.label || d.name,
      manufacturer: (d as { manufacturerName?: string }).manufacturerName,
      type: d.type,
      locationId: d.locationId,
      roomId: d.roomId,
      capabilities: (
        (d.components as Array<{ capabilities?: Array<{ id: string }> }>) || []
      ).flatMap((c) => (c.capabilities || []).map((cap) => cap.id)),
    }));
    return ok({ count: items.length, items });
  },
);

server.registerTool(
  'onecli_smartthings_get_device_status',
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
  'onecli_smartthings_send_command',
  {
    title: 'Send SmartThings Command',
    description:
      'Send a command to a device. Examples: turn a light on (`switch`/`on`), dim to 50% (`switchLevel`/`setLevel`/[50]), set thermostat to 70F (`thermostatCoolingSetpoint`/`setCoolingSetpoint`/[70]), unlock (`lock`/`unlock`). Use list_devices to get capabilities for a device, and SmartThings docs for capability/command/args reference.',
    inputSchema: {
      deviceId: z.string(),
      capability: z
        .string()
        .describe('Capability id, e.g. "switch", "switchLevel".'),
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
  'onecli_smartthings_list_scenes',
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
  'onecli_smartthings_execute_scene',
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
  'onecli_smartthings_get_history',
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
    // query string (epoch + hash). Returns null when:
    //   - the API didn't include _links.next (no more history),
    //   - the href can't be parsed as a URL (silent catch on invalid),
    //   - either expected param is missing.
    // Exported so tests can pin behavior across SmartThings response
    // shapes.
    return ok({
      count: items.length,
      items,
      nextPage: extractHistoryCursor(data._links?.next?.href),
    });
  },
);

server.registerTool(
  'onecli_smartthings_list_locations',
  {
    title: 'List SmartThings Locations',
    description:
      "List the user's SmartThings locations (homes / properties). Most users have one. Use the locationId to filter device/scene/room calls.",
    inputSchema: {},
  },
  async () => {
    const data = await st('GET', `${ST_BASE}/locations`);
    return ok(data);
  },
);

server.registerTool(
  'onecli_smartthings_list_rooms',
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

/**
 * Pull the SmartThings history cursor (epoch + hash) out of the API's
 * `_links.next.href` query string. Returns null when the input is
 * missing, malformed, or doesn't carry both expected params.
 *
 * Exported for unit testing because the underlying parse path uses a
 * silent try/catch that hides URL-construction errors — and the
 * cursor format is the only thing standing between "page through
 * history" and "infinite loop / stuck".
 */
export function extractHistoryCursor(
  nextHref: string | undefined | null,
): { epoch: number; hash: number } | null {
  if (!nextHref) return null;
  try {
    const u = new URL(nextHref);
    const e = u.searchParams.get('pagingBeforeEpoch');
    const h = u.searchParams.get('pagingBeforeHash');
    if (!e || !h) return null;
    const epoch = Number(e);
    const hash = Number(h);
    if (!Number.isFinite(epoch) || !Number.isFinite(hash)) return null;
    return { epoch, hash };
  } catch {
    return null;
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `[onecli-smartthings-mcp] fatal: ${err?.stack || err}\n`,
  );
  process.exit(1);
});
