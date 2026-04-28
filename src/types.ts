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
   * Opt this non-main group into the 15-min unanswered-message heartbeat.
   * Default: undefined / false — no heartbeat. The main group always gets
   * a heartbeat regardless of this flag (handled separately in
   * `registerGroup`). Made explicit by #158 to kill the historical
   * "trigger-required → auto-heartbeat" coupling.
   */
  enableHeartbeat?: boolean;
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
  // Channel-native message ID returned by the platform on send. Only
  // populated for outbound bot messages on Telegram — the `id` column
  // for bot sends is our synthetic `bot-<ts>-<rand>` so there's no other
  // place to pin the Telegram numeric ID. Inbound user messages already
  // store the platform ID as `id` itself and leave this null. Queryable
  // for debugging "what did the bot actually post at Telegram ID X?".
  //
  // Optional + NULL-able: writers may omit (column still defaults to
  // NULL via `?? null` in storeMessage), and DB getters surface the
  // persisted NULL as `null` IF their SELECT list includes the
  // column. The three runtime states:
  //   - `undefined` — writer didn't provide a value (normalized to
  //     NULL by storeMessage before persisting), OR reader loaded
  //     from a query whose explicit SELECT list doesn't include
  //     this column (e.g. `getNewMessages` / `getMessagesSince` in
  //     src/db.ts — they project a fixed subset of fields).
  //   - `null` — column was selected and the row's stored value is
  //     SQL NULL.
  //   - `string` — recorded bot-send id.
  // Call sites: writers with a known id pass a string; writers
  // without it omit; readers may see undefined / null / string
  // depending on the SELECT they went through.
  telegram_message_id?: string | null;
}

/**
 * Provenance of a scheduled_tasks row. Drives the agent-runner's decision
 * to wrap the prompt in `<untrusted-input>` at fire time.
 * - 'owner':           host code or Baruch's direct tooling — trusted
 * - 'main_agent':      main group's agent scheduled it — trusted
 * - 'trusted_agent':   trusted non-main group's agent — trusted
 * - 'untrusted_agent': untrusted group's agent — NOT trusted, wrap applies
 * The untrusted_agent case is the reason this field exists: without it,
 * an untrusted agent could self-schedule a malicious prompt that later
 * fires unwrapped and bypasses the trust boundary.
 */
export type CreatedByRole =
  | 'owner'
  | 'main_agent'
  | 'trusted_agent'
  | 'untrusted_agent';

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  /**
   * IANA timezone for evaluating `cron` expressions (e.g. "UTC",
   * "America/Chicago"). Null/undefined = use the server's `TIMEZONE`
   * config at fire time, preserving pre-#102 behavior. Has no effect
   * on `interval` (always elapsed-ms) or `once` — for `once`, any
   * offset-suffixed ISO-8601 (`Z`, `+HH:MM`, `-HH:MM`) is treated as
   * an absolute instant; bare strings without a suffix are
   * interpreted in server-local time at schedule/update time and
   * pinned to the resulting UTC moment in `next_run`.
   */
  schedule_timezone?: string | null;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  created_by_role: CreatedByRole;
  /**
   * Continuation marker for self-resuming cycles (#93/#130). NULL/undefined
   * for ordinary one-shot scheduled tasks. When set by the resumable-cycle
   * helper skill (in the `nanoclaw-admin` tile), the task-scheduler
   * surfaces the value to the spawned container as
   * `NANOCLAW_CONTINUATION=1` plus
   * `NANOCLAW_CONTINUATION_CYCLE_ID=<value>`. The calling skill (nightly /
   * weekly / morning-brief) checks the env var alongside a prompt-prefix
   * marker; both must agree to take the lock-skip continuation branch,
   * otherwise the run is treated as a fresh user invocation. A scheduler
   * that sets the env but mangles the prompt (or vice versa) therefore
   * fails closed instead of silently bypassing the two-phase lock.
   */
  continuation_cycle_id?: string | null;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
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
  // Optional: react to the most recent message in a chat.
  reactToLatestMessage?(jid: string, emoji: string): Promise<void>;
  // Optional: pin a message in the chat.
  pinMessage?(jid: string, messageId: string): Promise<void>;
  // Optional: send a file to the chat.
  sendFile?(
    jid: string,
    filePath: string,
    caption?: string,
    replyToMessageId?: string,
  ): Promise<void>;
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
