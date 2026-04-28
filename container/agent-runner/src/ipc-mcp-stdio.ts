/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
// Which per-group session slot this container occupies. Stamped onto every
// IPC request so the host responder writes `_script_result_*` replies into
// the right `input-<session>/` host dir — the one actually bind-mounted at
// `/workspace/ipc/input/` for this container.
const sessionName = process.env.NANOCLAW_SESSION_NAME || 'default';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Stamp `sessionName` onto EVERY IPC file the container emits (TASKS
  // and MESSAGES alike). Two consumers need it:
  //   - TASKS: the host responder routes `_script_result_*` replies
  //     back into THIS session's `input-<session>/` dir (which is
  //     what's bind-mounted at `/workspace/ipc/input/` for this
  //     container). Without the stamp, replies go to the default
  //     session's dir and this container polls forever.
  //   - MESSAGES: the host's outbound-message handler uses it to
  //     distinguish default-session (user-facing) messages from
  //     maintenance-session (scheduled-task) messages so the human
  //     knows which Andy persona is talking — e.g. prefixing the
  //     rendered text with `[M]` for maintenance. The `messages/`
  //     bind mount is shared across sessions within a group (see the
  //     mount setup in the orchestrator's container-runner), so the
  //     payload is the only place the session info can survive the
  //     IPC hop.
  //
  // Spread order: `sessionName` goes AFTER `...data` so the env-derived
  // value always wins over any caller-provided field. Without this, a
  // caller that passes `sessionName` in `data` — even by accident —
  // could lie about its session and either hijack another session's
  // responses or dodge the maintenance-prefix tagging.
  const payload = { ...(data as object), sessionName };

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

/**
 * Send a named host operation via IPC and poll for the result.
 * Each operation maps to a specific handler on the host with locked-down credentials.
 */
async function runHostOperation(
  type: string,
  extra?: Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // `sessionName` is stamped by `writeIpcFile` on every IPC payload
  // (both TASKS_DIR and MESSAGES_DIR), so we don't need to include it
  // in every caller's payload — and shouldn't, since the env-derived
  // stamp wins over caller-provided values by design.
  writeIpcFile(TASKS_DIR, {
    type,
    groupFolder,
    chatJid,
    requestId,
    timestamp: new Date().toISOString(),
    ...extra,
  });

  const resultPath = path.join(IPC_DIR, 'input', `_script_result_${requestId}.json`);
  const pollMs = 500;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(resultPath)) {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      fs.unlinkSync(resultPath);
      if (result.error) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: result.stdout || '(no output)' }] };
    }
    await new Promise(r => setTimeout(r, pollMs));
  }

  return { content: [{ type: 'text' as const, text: `Operation ${type} timed out` }], isError: true };
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Use reply_to with a message ID to quote-reply a specific message. To send to a different chat (cross-chat broadcast from main), pass chat_jid — only main containers may target other chats; trusted/untrusted containers can only target their own chat regardless of what's passed (host-side authz enforces this). When chat_jid is set, do NOT pass reply_to unless you have a message ID from the TARGET chat — Telegram message IDs are per-chat, so a source-chat ID will resolve to an unrelated message in the target chat.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
    reply_to: z.string().optional().describe('Message ID to reply to (quote). Get this from the [id=...] tag in the message prompt. If omitted, the message is sent without quote-threading. For cross-chat sends (chat_jid set), only pass this if it refers to a message in the TARGET chat — Telegram message IDs are per-chat.'),
    pin: z.boolean().optional().describe('Pin this message in the chat after sending. Use for important messages like daily briefs.'),
    chat_jid: z
      .string()
      .optional()
      .describe(
        'Target chat JID for cross-chat sends (e.g., "tg:-1003869886477"). Only honored when called from a main container; other tiers always send to their own chat. Use sparingly — most replies should go to the chat the prompt arrived in. Sent messages are recorded in messages.db just like normal sends, so the agent and heartbeat see them.',
      ),
  },
  async (args) => {
    const data: Record<string, string | boolean | undefined> = {
      type: 'message',
      chatJid: args.chat_jid || chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    // Only reply-thread when the caller explicitly passes reply_to.
    // We never auto-fill from "the most recent incoming message" — that
    // pattern silently misthreads cross-chat broadcasts: Telegram message
    // IDs are per-chat, so a source-chat ID resolves to an unrelated
    // message in the target chat. See nanoclaw-public#7.
    if (args.reply_to) {
      data.replyToMessageId = args.reply_to;
    }

    if (args.pin) {
      data.pin = true;
    }

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: args.pin ? 'Message sent and pinned.' : 'Message sent.' }] };
  },
);

server.tool(
  'send_file',
  'Send a file from the workspace to the user via Telegram. The file must exist on the container filesystem. Use for generated reports, exports, or any file the user asked you to create. Trusted containers only.',
  {
    filePath: z.string().describe('Absolute path to the file in the container (e.g., /workspace/group/report.csv)'),
    caption: z.string().optional().describe('Optional caption to send with the file'),
    reply_to: z.string().optional().describe('Message ID to reply to'),
  },
  async (args) => {
    // Path must live under a host-readable mount. Anything else (notably
    // /tmp — tmpfs inside the container, invisible to the host) gets
    // dropped silently by the host-side validator. Reject upfront so the
    // agent gets immediate, actionable feedback instead of fake-success.
    const allowedPrefixes = [
      '/workspace/group/',
      '/workspace/trusted/',
      '/workspace/extra/',
    ];
    if (!allowedPrefixes.some((p) => args.filePath.startsWith(p))) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Path not deliverable: ${args.filePath}. ` +
              `send_file only sends files from host-readable mounts. ` +
              `Write the file under /workspace/group/ (your group folder) ` +
              `instead — /tmp/ is container-only tmpfs and the host can't read it.`,
          },
        ],
        isError: true,
      };
    }

    if (!fs.existsSync(args.filePath)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.filePath}` }],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'send_file',
      chatJid,
      filePath: args.filePath,
      caption: args.caption,
      replyToMessageId: args.reply_to,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `File queued for sending: ${path.basename(args.filePath)}` }] };
  },
);

server.tool(
  'send_voice',
  'Send a voice (audio) reply to the user via Telegram. Synthesizes the text using OpenAI TTS and uploads as a Telegram voice note. Use when the user sent a voice message and would prefer voice back, or when explicitly asked to reply by voice. Keep text under ~500 chars — TTS is cheap but very long messages feel awkward as audio. Use plain prose without HTML tags or markdown.',
  {
    text: z.string().describe('The text to speak (plain prose, no HTML/markdown).'),
    voice: z
      .enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])
      .optional()
      .describe('OpenAI TTS voice (default: alloy).'),
    reply_to: z.string().optional().describe('Message ID to reply to.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'send_voice',
      chatJid,
      text: args.text,
      voice: args.voice || 'alloy',
      replyToMessageId: args.reply_to,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return { content: [{ type: 'text' as const, text: 'Voice queued for sending.' }] };
  },
);

server.tool(
  'react_to_message',
  'React to a message with an emoji. Use to acknowledge, approve, or express sentiment without sending a full text reply. Invalid emoji falls back to 👍.',
  {
    messageId: z.string().optional().describe('Message ID to react to. If omitted, reacts to the most recent message.'),
    emoji: z.string().describe('Telegram reaction emoji. 73 supported: 👍👎❤🔥🥰👏😁🤔🤯😱🤬😢🎉🤩🤮💩🙏👌🕊🤡🥱🥴😍🐳❤‍🔥🌚🌭💯🤣⚡🍌🏆💔🤨😐🍓🍾💋🖕😈😴😭🤓👻👨‍💻👀🎃🙈😇😨🤝✍🤗🫡🎅🎄☃💅🤪🗿🆒💘🙉🦄😘💊🙊😎👾🤷‍♂🤷🤷‍♀😡. Invalid falls back to 👍.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'react_to_message',
      chatJid,
      messageId: args.messageId || undefined,
      emoji: args.emoji,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return { content: [{ type: 'text' as const, text: `Reacted with ${args.emoji}` }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT:
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *"). By default evaluated in the server's local timezone. Pass an explicit \`timezone\` (IANA name like "UTC" or "America/Chicago") for tz-stable cron schedules \u2014 recommended for anything you want to fire at a specific UTC moment regardless of where the server is.
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: UTC ISO-8601 with "Z" suffix (e.g., "2026-02-01T15:30:00Z") \u2014 RECOMMENDED. The task fires at exactly that UTC moment regardless of server timezone changes. Local strings without a suffix (e.g., "2026-02-01T15:30:00") still work and are pinned to the absolute instant they resolve to in the server's CURRENT tz at SCHEDULE time \u2014 but if you compose them by converting from a UTC anchor in your head, a tz change between when you schedule and when you compose the next one will silently shift those next ones, since you'll be doing the UTC\u2192local math against the wrong tz. UTC strings remove that whole class of bug.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: UTC ISO-8601 like "2026-02-01T15:30:00Z" (recommended) or local-time without suffix (deprecated)',
      ),
    timezone: z
      .string()
      .optional()
      .describe(
        'IANA timezone for cron expressions (e.g., "UTC", "America/Chicago"). Defaults to server local timezone. Has no effect on interval or once. Recommended: pass "UTC" for cron schedules anchored to absolute time.',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch (err) {
        // CronExpressionParser only throws Error instances on invalid
        // syntax. Anything non-Error here is an upstream bug; let it
        // propagate per `jbaruch/coding-policy: error-handling`.
        if (!(err instanceof Error)) throw err;
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      // #102: UTC `Z`-suffixed strings are now the RECOMMENDED form
      // (they're tz-stable across server tz changes). Local-time strings
      // without a suffix still work — the host pins them to an absolute
      // UTC instant at SCHEDULE time via `new Date(s).toISOString()`,
      // and `next_run` is then a fixed instant the scheduler fires on
      // regardless of any later tz change. The class of bug UTC
      // strings sidestep is at *compose* time: when an agent
      // mentally converts a UTC anchor to local against the server's
      // CURRENT tz to build the string, a tz change between when the
      // string is composed and when the next one is composed silently
      // shifts each subsequent task. UTC strings remove that math.
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Recommended format: UTC ISO-8601 like "2026-02-01T15:30:00Z".`,
            },
          ],
          isError: true,
        };
      }
    }

    // #102: validate optional IANA timezone for cron. Only validate
    // when it'd actually be used (cron) — host already drops it for
    // non-cron, and rejecting on a non-cron schedule for a typo'd
    // tz that has no effect would be unhelpful pedantry.
    // Skip empty-string tz: the host treats it as "no tz provided"
    // and falls back to TIMEZONE, so failing the call here would be
    // stricter than the host accepts.
    if (
      args.timezone !== undefined &&
      args.timezone !== '' &&
      args.schedule_type === 'cron'
    ) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: args.timezone });
      } catch (err) {
        // `Intl.DateTimeFormat` throws RangeError on unknown IANA tz.
        // Anything non-Error is a host bug; propagate per
        // `jbaruch/coding-policy: error-handling`.
        if (!(err instanceof Error)) throw err;
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid IANA timezone: "${args.timezone}". Use names like "UTC", "America/Chicago", "Europe/Berlin".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data: Record<string, unknown> = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };
    // Only forward `timezone` for cron tasks. The host already drops
    // it for non-cron schedule types, but pruning at the source keeps
    // the IPC payload semantically clean and avoids the "stray field"
    // confusion Copilot flagged on review.
    if (args.timezone !== undefined && args.schedule_type === 'cron') {
      data.timezone = args.timezone;
    }

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    timezone: z
      .string()
      .optional()
      .describe(
        'New IANA timezone for cron (e.g., "UTC", "America/Chicago"). Empty string clears it (back to server default). See #102.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value when provided, but ONLY against the
    // explicitly-asserted schedule_type. The previous gate also tried
    // cron-validating any update with a schedule_value but no type —
    // which incorrectly rejected valid once-timestamps and interval
    // millisecond strings during partial updates that left the type
    // unchanged. The host re-validates against the post-update type
    // anyway, so the agent-side check should be conservative: only
    // catch the cases where the caller explicitly said "this is a
    // cron" or "this is an interval".
    if (args.schedule_type === 'cron' && args.schedule_value) {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch (err) {
        // See schedule_task above — same Error-or-rethrow pattern per
        // `jbaruch/coding-policy: error-handling`.
        if (!(err instanceof Error)) throw err;
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }
    // Validate any non-empty timezone unless the caller is EXPLICITLY
    // changing schedule_type to once/interval (where tz is documented
    // to have no effect — the host drops it). This catches the common
    // case of a partial update that touches an existing cron task's
    // tz without re-stating schedule_type. Empty string is the
    // documented "clear back to TIMEZONE default" signal and skips
    // validation by design.
    if (
      args.timezone !== undefined &&
      args.timezone !== '' &&
      args.schedule_type !== 'once' &&
      args.schedule_type !== 'interval'
    ) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: args.timezone });
      } catch (err) {
        // See schedule_task above — same Error-or-rethrow pattern per
        // `jbaruch/coding-policy: error-handling`.
        if (!(err instanceof Error)) throw err;
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid IANA timezone: "${args.timezone}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;
    if (args.timezone !== undefined) data.timezone = args.timezone;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .trim()
      .min(1)
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456"). Whitespace-only rejected.',
      ),
    name: z.string().trim().min(1).describe('Display name for the group'),
    folder: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z
      .string()
      .trim()
      .min(1)
      .describe('Trigger word (e.g., "@Andy"). Whitespace-only rejected.'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
    trusted: z.boolean().optional().describe('Whether the group gets a trusted container (read-write filesystem, admin tiles, longer timeout). Default: false. Set true for personal/friends groups.'),
    enableHeartbeat: z.boolean().optional().describe('Opt this non-main group into the 15-min unanswered-message heartbeat. Default: false. Pre-#158 this was implicit on requiresTrigger; now explicit.'),
    additionalMounts: z.array(z.object({
      hostPath: z.string().describe('Path on the host (supports "~" expansion; does not need to be absolute).'),
      containerPath: z.string().optional().describe('Optional mount name inside /workspace/extra/. When omitted, the host derives it from basename(hostPath).'),
      readonly: z.boolean().optional().describe('Mount as read-only (default). Set to false to request read-write access.'),
    })).optional().describe('Extra volume mounts for the container, passed through to the host.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const containerConfig = (args.trusted !== undefined || args.enableHeartbeat !== undefined || args.additionalMounts)
      ? {
          ...(args.trusted !== undefined ? { trusted: args.trusted } : {}),
          ...(args.enableHeartbeat !== undefined ? { enableHeartbeat: args.enableHeartbeat } : {}),
          ...(args.additionalMounts ? { additionalMounts: args.additionalMounts } : {}),
        }
      : undefined;

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      containerConfig,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

server.tool(
  'unregister_group',
  `Remove a chat/group from the registry so the agent stops responding there. Main group only.

Inverse of \`register_group\` (#159). Removes both the SQLite \`registered_groups\` row AND the JID's authoritative entry in \`available_groups.json\` in one call. The on-disk \`groups/<folder>/\` directory (CLAUDE.md, MEMORY.md, scheduled-task workspace) is left intact — operators delete that manually if/when they want a clean slate.

Refuses to unregister the main group itself (losing the main registration mid-runtime would leave the orchestrator without an IPC path to recreate it). No-op when the JID isn't registered.`,
  {
    jid: z
      .string()
      .trim()
      .min(1)
      .describe(
        'The chat JID of the registered group to remove (e.g., "tg:1698969", "120363336345536173@g.us"). Whitespace-only rejected.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can unregister groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'unregister_group',
      jid: args.jid,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Unregister requested for ${args.jid}. (No-op if the JID wasn't registered. The on-disk groups/<folder>/ directory is preserved — delete manually if no longer needed.)`,
        },
      ],
    };
  },
);

server.tool(
  'set_trusted',
  `Flip a registered group's \`trusted\` flag without re-stating its other parameters. Main group only.

Use this when promoting a chat to trusted (read-write filesystem, admin tiles, longer timeout) or demoting it back. Does NOT register a new group — call \`register_group\` first if the JID isn't already registered. The trigger word, folder, and additionalMounts are preserved.`,
  {
    jid: z
      .string()
      .trim()
      .min(1)
      .describe(
        'The chat JID of an already-registered group (e.g., "tg:-1001234567890"). Whitespace-only rejected.',
      ),
    trusted: z
      .boolean()
      .describe(
        'true = trusted container (RW filesystem, admin tiles); false = untrusted container',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can change trust state.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'set_trusted',
      // `args.jid` is already trimmed by the Zod schema's `.trim()`
      // transform — pass through verbatim.
      jid: args.jid,
      trusted: args.trusted,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          // "requested" rather than "set": the host receives the IPC
          // file and applies it asynchronously, and may no-op if the
          // JID isn't registered. We can't confirm the actual write
          // from this side without a synchronous round-trip.
          text: `Trust update requested for ${args.jid} → ${args.trusted}. (No-op if the JID isn't registered — call register_group first.)`,
        },
      ],
    };
  },
);

server.tool(
  'set_trigger',
  `Change a registered group's trigger word (and optionally requiresTrigger) without re-stating its other parameters. Main group only.

Use this when renaming the assistant in a chat or switching between always-respond and trigger-only modes. Does NOT register a new group — call \`register_group\` first if the JID isn't already registered.`,
  {
    jid: z
      .string()
      .trim()
      .min(1)
      .describe(
        'The chat JID of an already-registered group. Whitespace-only rejected.',
      ),
    // `.trim()` + `.min(1)` rejects empty/whitespace-only triggers.
    // Why: `getTriggerPattern('')` trims and falls back to
    // `DEFAULT_TRIGGER`, so a caller setting a custom trigger to an
    // empty string would silently get the assistant's default trigger
    // word back — not what they asked for. Trim also normalizes
    // surrounding whitespace so `' @Andy '` doesn't store as such.
    trigger: z
      .string()
      .trim()
      .min(1)
      .describe(
        'New non-empty trigger word (e.g., "@Andy"). Replaces the existing trigger. Surrounding whitespace is trimmed.',
      ),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Omit to leave unchanged.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can change trigger config.',
          },
        ],
        isError: true,
      };
    }

    const data: Record<string, unknown> = {
      type: 'set_trigger',
      jid: args.jid,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };
    if (args.requiresTrigger !== undefined) {
      data.requiresTrigger = args.requiresTrigger;
    }

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          // "requested" rather than "set": host applies asynchronously and
          // may no-op if the JID isn't registered.
          text:
            args.requiresTrigger === undefined
              ? `Trigger update requested for ${args.jid} → "${args.trigger}". (No-op if the JID isn't registered — call register_group first.)`
              : `Trigger update requested for ${args.jid} → "${args.trigger}" (requiresTrigger=${args.requiresTrigger}). (No-op if the JID isn't registered — call register_group first.)`,
        },
      ],
    };
  },
);

server.tool(
  'nuke_session',
  "Destructive: kill this group's container(s), drop the session DB row(s), AND delete the on-disk JSONL transcript for the targeted slot(s). Next message/scheduled tick starts a TRULY fresh session — no resumed transcript. Use when context is corrupted, rules are stale, poison reached the model, or user asks to start fresh. Parallel-maintenance groups run two containers per group (user-facing `default` + scheduled-task `maintenance`) — pass `session` to narrow the nuke: 'default' keeps maintenance running, 'maintenance' keeps user-facing running, 'all' (default) wipes both. Cannot be undone — the JSONL is gone after this.",
  {
    session: z
      .enum(['default', 'maintenance', 'all'])
      .optional()
      .describe(
        "Which session slot to kill. 'default' = user-facing container only (preserves scheduled-task session chain). 'maintenance' = scheduled-task container only (preserves user-facing conversation state). 'all' or omitted = both.",
      ),
  },
  async (args) => {
    const session = args.session ?? 'all';
    const data = {
      type: 'nuke_session',
      groupFolder,
      session,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const scopeText =
      session === 'all'
        ? 'Both containers will be killed'
        : `The ${session} container will be killed`;
    const nextStartText =
      session === 'all'
        ? 'message / scheduled task'
        : session === 'maintenance'
          ? 'scheduled task'
          : 'message';
    return {
      content: [
        {
          type: 'text' as const,
          text: `Session nuked (scope: ${session}). ${scopeText}. Next ${nextStartText} starts fresh.`,
        },
      ],
    };
  },
);

// --- Named host operations ---

// --- Smart Home ---

server.tool(
  'github_backup',
  'Commit and push the group backup repo to GitHub. Use for nightly backups or when important state changes. The host handles git credentials — the container just triggers it.',
  {
    message: z.string().optional().describe('Commit message. Default: "backup: <ISO date>"'),
  },
  async (args) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'github_backup',
      groupFolder,
      chatJid,
      message: args.message,
      requestId,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Poll for result file
    const resultPath = path.join(IPC_DIR, 'input', `_script_result_${requestId}.json`);
    const timeoutMs = 60_000;
    const pollMs = 500;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(resultPath)) {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        fs.unlinkSync(resultPath);
        if (result.error) {
          return {
            content: [{ type: 'text' as const, text: `Backup failed: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: result.stdout || 'Backup pushed.' }],
        };
      }
      await new Promise(r => setTimeout(r, pollMs));
    }

    return {
      content: [{ type: 'text' as const, text: 'Backup timed out after 60s' }],
      isError: true,
    };
  },
);

// Five tile repos the promote flow is wired against. Host-side
// `KNOWN_TILE_NAMES` in src/ipc.ts enforces this as the real security
// boundary; keeping the same list as a zod enum here gives callers a
// clear client-side error (at tool-call time) instead of a generic
// "host operation failed" after round-tripping to the orchestrator.
const TILE_NAMES = [
  'nanoclaw-admin',
  'nanoclaw-core',
  'nanoclaw-untrusted',
  'nanoclaw-trusted',
  'nanoclaw-host',
] as const;

server.tool(
  'promote_staging',
  'Promote staged skills and rules to a tile repo. Copies staging into a fresh clone, runs a read-only `tessl skill review` pass on each promoted skill when `tessl` is on PATH (reports score; never mutates content; skipped with a warning when unavailable — Copilot + the post-merge GHA review still gate the PR), pushes a timestamped `promote/<utc>-<tile>-<rand>` branch, opens a PR on the tile repo, and summons Copilot review via GraphQL. Does NOT merge, push to main, or publish to the registry — merge is manual (or via Composio), publish fires in GHA at merge time, and the agent calls `tessl_update` afterwards to pull the new version. Main group only.',
  {
    tileName: z.enum(TILE_NAMES).describe('Target tile repo.'),
    skillName: z.string().optional().describe('Specific skill to promote. Omit for all staging items. Use "--rules-only" to promote only rules.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can promote tiles.' }],
        isError: true,
      };
    }

    // 15 minutes matches the host-side execFile cap in src/ipc.ts. The
    // previous hand-rolled 5-minute poll would time out and report
    // failure while the host script was still running (observed on
    // bulk promotes with 10+ skills hitting the tessl review loop at
    // ~1 min/skill). Delegate poll plumbing to runHostOperation so
    // this tool inherits future tweaks to result-file handling etc.
    return runHostOperation(
      'promote_staging',
      {
        tileName: args.tileName,
        skillName: args.skillName || 'all',
      },
      900_000,
    );
  },
);

server.tool(
  'push_staged_to_branch',
  `Push fixups from this group's staging directory to an existing tile-repo PR branch. Use after a promote PR gets review comments: fix the skill back in staging, then call this with the branch name that promote_staging printed ("Branch: promote/...-<tile>"). No new PR is opened — the existing PR auto-updates. Main group only.

skillName options:
- omit → push everything currently in staging
- specific skill (e.g. "tessl__check-unanswered") → push only that skill
- "--rules-only" → push only rules`,
  {
    tileName: z
      .enum(TILE_NAMES)
      .describe('Target tile repo (same one the PR is against).'),
    branch: z
      .string()
      .min(1)
      .describe(
        'Existing PR branch, e.g. "promote/20260418T224156Z-nanoclaw-core-a3b2". Parse it from the `Branch: ...` line in promote_staging output.',
      ),
    commitMessage: z
      .string()
      .min(1)
      .describe(
        'Short commit message describing the fixup (e.g. "fix: address Copilot comment on unanswered-precheck.py").',
      ),
    skillName: z
      .string()
      .optional()
      .describe(
        'Specific skill to push. Omit for all staging items. Use "--rules-only" to push only rules.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          { type: 'text' as const, text: 'Only the main group can push to tile branches.' },
        ],
        isError: true,
      };
    }

    // Reuse runHostOperation for the write-IPC + poll-for-result
    // plumbing. Keeps timeout/poll cadence/result-file cleanup
    // consistent across all host-operation MCP tools (sync_tripit,
    // tessl_update, push_staged_to_branch, etc.), so a future change
    // to (say) how result files are formatted doesn't require
    // updating each tool's poll loop.
    return runHostOperation(
      'push_staged_to_branch',
      {
        tileName: args.tileName,
        branch: args.branch,
        commitMessage: args.commitMessage,
        skillName: args.skillName || 'all',
      },
      300_000,
    );
  },
);

server.tool(
  'chat_status',
  'Report host-side state for one or all registered chats: which tile owns each chat (admin/trusted/untrusted), trigger config, container status (running/idle/cooling-down/crashed/not-spawned) per session slot (default + maintenance), and the latest is_from_me=1 message recorded for the chat. Use this to diagnose silent containers — when a chat went quiet you can see whether the container is running, cooling down after an error, or never spawned. Provide chat_id (JID) OR chat_name (display name) to filter to one chat; omit both for all chats. Main group only.',
  {
    chat_id: z
      .string()
      .optional()
      .describe(
        'Specific chat JID, e.g. tg:-1003869886477. Mutually exclusive with chat_name.',
      ),
    chat_name: z
      .string()
      .optional()
      .describe(
        'Chat display name (looked up against the registered groups list). Errors if ambiguous; pass chat_id instead in that case.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'chat_status is admin-tile only.',
          },
        ],
        isError: true,
      };
    }
    // chat_id and chat_name are mutually exclusive — passing both
    // means two identifiers that might disagree, and silently
    // prioritizing one over the other is unsafe targeting. Reject
    // here so the agent gets a clear schema error rather than a
    // surprise from the host handler. The host enforces the same
    // rule as defense in depth (in case a future client bypasses
    // the MCP layer).
    if (args.chat_id && args.chat_name) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Provide chat_id OR chat_name, not both.',
          },
        ],
        isError: true,
      };
    }
    return runHostOperation('chat_status', {
      chat_id: args.chat_id,
      chat_name: args.chat_name,
    });
  },
);

server.tool(
  'nuke_chat',
  "Forcibly nuke another chat's session(s) cross-chat — wipes JSONL transcripts, kills the container, and clears DB session rows. Use when a foreign chat's container is hung, in a corrupted state, or stuck on a poisoned plan and the only way back is a clean restart. Requires chat_id OR chat_name (admin always operates cross-chat — to nuke your own chat use nuke_session). Main group only.",
  {
    chat_id: z
      .string()
      .optional()
      .describe('Specific chat JID, e.g. tg:-1003869886477.'),
    chat_name: z
      .string()
      .optional()
      .describe(
        'Chat display name. Errors if ambiguous; pass chat_id instead in that case.',
      ),
    session: z
      .enum(['default', 'maintenance', 'all'])
      .optional()
      .describe(
        "Which session slot(s) to wipe. 'default' is the user-facing container, 'maintenance' is the scheduled-task container, 'all' (the default) does both.",
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'nuke_chat is admin-tile only.',
          },
        ],
        isError: true,
      };
    }
    if (!args.chat_id && !args.chat_name) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'nuke_chat requires chat_id or chat_name — admin always operates cross-chat. Use nuke_session to wipe the current chat.',
          },
        ],
        isError: true,
      };
    }
    // Two identifiers are an unsafe-targeting smell — see the same
    // rule on chat_status above. Reject before the IPC round-trip.
    if (args.chat_id && args.chat_name) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Provide chat_id OR chat_name, not both.',
          },
        ],
        isError: true,
      };
    }
    return runHostOperation('nuke_chat', {
      chat_id: args.chat_id,
      chat_name: args.chat_name,
      session: args.session,
    });
  },
);

server.tool(
  'tessl_update',
  'Run `tessl update` on the host to pull the latest tile versions from the registry. Call this after a promote PR merges (GHA publishes on merge, then the agent triggers this to get the new version). If new tiles land, sessions are cleared automatically so the next message picks them up. A periodic 15-min catch-up runs in the orchestrator as a safety net. Main group only.',
  {},
  async () => {
    if (!isMain) {
      return {
        content: [
          { type: 'text' as const, text: 'Only the main group can trigger tessl_update.' },
        ],
        isError: true,
      };
    }
    return runHostOperation('tessl_update');
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
