export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  trusted?: boolean; // Trusted groups get limited credentials (e.g. voice transcription)
  /**
   * Override the global AGENT_MODEL env var for this group. Pass-through to
   * agent-runner via env. Validated against the same prefix regex as the
   * global resolver (`resolveAgentModel`) — invalid value (or empty string)
   * falls back to the global default with a warn log so the container still
   * spawns instead of refusing to run on a per-group typo.
   *
   * Examples: `"haiku"`, `"sonnet"`, `"claude-haiku-4-5-20251001"`,
   * `"claude-sonnet-4-6[1m]"`.
   *
   * Use case: cheap noisy chats (`telegram_old-wtf`) on Haiku, high-value
   * engineering work (`telegram_main`) on Sonnet/Opus — projected ~$10-20/day
   * savings versus uniform Sonnet/Opus across all groups.
   */
  agentModel?: string;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  /**
   * Continuation marker for self-resuming cycles. NULL/undefined for
   * ordinary one-shot scheduled tasks. When set by a continuation-aware
   * caller (helper skill), the task-scheduler surfaces the value to the
   * spawned container as `NANOCLAW_CONTINUATION=1` plus
   * `NANOCLAW_CONTINUATION_CYCLE_ID=<value>`. The calling skill checks
   * the env var alongside a prompt-prefix marker; both must agree to
   * take a continuation branch, otherwise the run is treated as a fresh
   * user invocation. A scheduler that sets the env but mangles the
   * prompt (or vice versa) therefore fails closed instead of silently
   * bypassing whatever lock/state contract the chain depends on.
   */
  continuation_cycle_id?: string | null;
  /**
   * Per-task SDK session id (#59 / jbaruch#336). NULL/undefined for tasks
   * that have never fired, for once-tasks (out of scope), and for recurring
   * tasks immediately after a `nukeSession` clear. Populated by `runTask`
   * on first fire of a recurring task and reused as `resume:` on subsequent
   * fires so the API caches the per-session message-history prefix across
   * the (otherwise expiring 5-min) prompt-cache window. Persistence is
   * keyed on `task_id`, so different tasks have different rows hence
   * different sessions — no #193-style cross-task bleed.
   */
  session_id?: string | null;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  // 'timeout' was added by the per-task watchdog (#30 Part C) so the
  // killed-by-watchdog failure mode is queryable separately from
  // ordinary script/agent errors. Both still set `error` for `last_result`
  // formatting; only the discriminator on `task_run_logs` differs.
  status: 'success' | 'error' | 'timeout';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<string | void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: send an emoji reaction to a message.
  sendReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  // Optional: report whether a JID points at a 1:1 / DM chat (true) vs.
  // a multi-participant group / channel (false). Used by the observer
  // module to refuse to mirror reasoning into a chat that isn't owner-
  // only. Channels that can't determine this should leave it
  // unimplemented; callers must treat "unknown" as not-private.
  isPrivateChat?(jid: string): Promise<boolean>;
  // Optional: react to the most recent message in a chat.
  reactToLatestMessage?(jid: string, emoji: string): Promise<void>;
  // Optional: pin a message in the chat.
  pinMessage?(jid: string, messageId: string): Promise<void>;
  // Optional: synthesize text to speech and send as a voice note.
  sendVoice?(
    jid: string,
    text: string,
    voice: string,
    replyToMessageId?: string,
  ): Promise<void>;
  // Optional: send a file to the chat.
  sendFile?(
    jid: string,
    filePath: string,
    caption?: string,
    replyToMessageId?: string,
  ): Promise<void>;
  // Optional: create a draft stream for progressive message display.
  createDraftStream?(
    jid: string,
    replyToMessageId?: string,
  ): import('./draft-stream.js').DraftStream;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
