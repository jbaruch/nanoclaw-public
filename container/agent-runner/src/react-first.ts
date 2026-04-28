/**
 * react-first — gate logic for the `UserPromptSubmit` hook (#136).
 *
 * Whenever a user inbound lands, the agent's behavioural rule is
 * "react with an emoji to acknowledge — silence means success, text
 * means there's something worth saying." When the model forgets to
 * react, the user has zero signal that the message was received.
 * Silence is the success state, so absence of a reaction is
 * indistinguishable from "container down" or "model crashed mid-turn".
 *
 * The hook synthesises a `react_to_message` IPC call before any LLM
 * tokens are spent. The agent can still emit a more specific reaction
 * later in the turn — this only guarantees *some* reaction happened.
 *
 * This module is the pure decision half: the wiring half lives in
 * `index.ts` (`createReactFirstHook`) which writes the IPC payload.
 * Kept SDK-free so the root vitest can exercise it without spinning
 * up `@anthropic-ai/claude-agent-sdk`.
 */

export interface ReactFirstGateInput {
  /**
   * Whether the container was spawned to run a scheduled task. Set
   * from `ContainerInput.isScheduledTask`. Scheduled tasks have no
   * triggering user inbound to react to.
   */
  isScheduledTask: boolean;
  /**
   * True iff the hook fired from inside a sub-agent (the SDK puts
   * `agent_id` on `BaseHookInput` when so). Sub-agents emit their
   * own internal prompts; reacting on those would queue a Telegram
   * reaction for an event the human never sent.
   */
  isSubagent: boolean;
  /**
   * The submitted prompt string. We sniff for the orchestrator-side
   * `[SCHEDULED TASK]` wrap as a defence-in-depth check — the
   * `isScheduledTask` field above already covers this, but the
   * orchestrator has bypassed it on certain owner-tier code paths.
   * Both gates miss only when both gates are wrong, which is easier
   * to reason about than a single one of them being right.
   */
  prompt: string;
  /**
   * Group's `assistantName` (e.g. 'Andy'). Containers without a
   * named user-facing assistant — internal maintenance slots, the
   * orchestrator's own probes — shouldn't react. The existing
   * PreCompact hook already gates on this same field.
   */
  assistantName?: string;
}

/**
 * Discriminated union so callers can't accidentally read
 * `skippedBy` off a positive decision (or log `undefined` off a
 * malformed negative one).
 */
export type ReactFirstDecision =
  | { react: true }
  | {
      react: false;
      skippedBy:
        | 'scheduled-task'
        | 'subagent'
        | 'no-assistant-name'
        | 'scheduled-task-prompt-wrap';
    };

const SCHEDULED_TASK_PROMPT_PREFIX = '[SCHEDULED TASK]';

/**
 * Pure decision: should the react-first hook fire on this submission?
 *
 * The order of gates below is significant — earlier gates are cheaper
 * and produce more semantic-meaningful `skippedBy` tags. A tag of
 * `subagent` is more useful for triage than the same submission also
 * matching `no-assistant-name` if the sub-agent ran in a no-name slot.
 */
export function decideReactFirst(input: ReactFirstGateInput): ReactFirstDecision {
  if (input.isSubagent) {
    return { react: false, skippedBy: 'subagent' };
  }
  if (input.isScheduledTask) {
    return { react: false, skippedBy: 'scheduled-task' };
  }
  // Defence-in-depth: orchestrator may pass `isScheduledTask=false` on
  // a container it spun up to run an owner-tier scheduled task, but the
  // prompt itself is wrapped with `[SCHEDULED TASK]` (see the wrap in
  // index.ts:`Script phase`). Skip in that case too.
  if (input.prompt.startsWith(SCHEDULED_TASK_PROMPT_PREFIX)) {
    return { react: false, skippedBy: 'scheduled-task-prompt-wrap' };
  }
  if (!input.assistantName || input.assistantName.length === 0) {
    return { react: false, skippedBy: 'no-assistant-name' };
  }
  return { react: true };
}

/**
 * The default acknowledgement emoji. 👀 — "I see this." The agent can
 * still react with a more specific emoji later in the turn (Telegram
 * replaces the bot's reaction on each new react_to_message call), so
 * this is a floor, not a ceiling.
 */
export const REACT_FIRST_DEFAULT_EMOJI = '👀';

/**
 * IPC payload shape the hook hands to its writer. Same fields the
 * MCP `react_to_message` tool emits — see `ipc-mcp-stdio.ts`. The
 * shape is mirrored here so the wiring half (in `index.ts`) is just
 * a JSON-write call, and so this module can stay SDK-free + testable
 * without depending on the MCP server's runtime constants.
 */
export interface ReactToMessageIpcPayload {
  type: 'react_to_message';
  chatJid: string;
  groupFolder: string;
  sessionName: string;
  emoji: string;
  messageId?: string;
  timestamp: string;
}

export type ReactIpcWriter = (payload: ReactToMessageIpcPayload) => void;

/**
 * Full input shape the wired hook receives. Folds the gate input
 * (`ReactFirstGateInput`) together with the IPC routing fields needed
 * to write the payload. `index.ts` builds this from `containerInput`
 * + `submit.prompt` + `submit.agent_id`.
 */
export interface ReactFirstHookInput extends ReactFirstGateInput {
  /** Telegram (or other channel) chat JID for the IPC payload. */
  chatJid: string;
  /** Group folder name — `groups/<folder>/...`. */
  groupFolder: string;
  /**
   * Per-group session slot. Caller already applies the
   * `|| 'default'` fallback used elsewhere in the agent-runner so
   * an empty value never reaches the IPC layer.
   */
  sessionName: string;
}

/**
 * Outcome of one hook fire — emitted reaction, or the named skip
 * reason, plus IPC-write failure detail when the writer threw an
 * expected NodeJS.ErrnoException.
 */
export type ReactFirstHookResult =
  | { kind: 'emitted'; emoji: string }
  | {
      kind: 'skipped';
      skipReason:
        | 'scheduled-task'
        | 'subagent'
        | 'no-assistant-name'
        | 'scheduled-task-prompt-wrap';
    }
  | { kind: 'ipc-failed'; emoji: string; code: string; message: string };

/**
 * Allow-list of filesystem error codes the IPC writer is expected to
 * surface — same shape as the auto-context loaders in `session-start-context.ts`.
 * Anything else propagates so a programming bug isn't silently
 * swallowed as "missing acknowledgement".
 */
const EXPECTED_IPC_WRITE_ERROR_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EROFS',
]);

function isExpectedIpcWriteError(err: unknown): NodeJS.ErrnoException | null {
  const errno = err as NodeJS.ErrnoException | null | undefined;
  if (
    errno &&
    typeof errno.code === 'string' &&
    EXPECTED_IPC_WRITE_ERROR_CODES.has(errno.code)
  ) {
    return errno;
  }
  return null;
}

/**
 * Pure execution of the hook's run-time path. The caller injects an
 * IPC writer so this module never imports `fs`; that lets the unit
 * tests exercise the full sequence — gate decision, payload shaping,
 * graceful IPC-failure handling — without mocking the filesystem.
 *
 * Decision tree:
 *  1. Gate via `decideReactFirst`. On a skip, return `{ kind: 'skipped' }`
 *     with the gate's reason.
 *  2. Build the IPC payload with the default emoji + a fresh
 *     timestamp.
 *  3. Invoke `ipcWriter(payload)`. On expected NodeJS.ErrnoException
 *     (the allow-list above), return `{ kind: 'ipc-failed' }` so the
 *     caller can log without crashing the prompt. Other errors
 *     propagate.
 *  4. Return `{ kind: 'emitted', emoji }` on success.
 */
export function runReactFirstHook(
  input: ReactFirstHookInput,
  ipcWriter: ReactIpcWriter,
  now: () => Date = () => new Date(),
): ReactFirstHookResult {
  const decision = decideReactFirst({
    isScheduledTask: input.isScheduledTask,
    isSubagent: input.isSubagent,
    prompt: input.prompt,
    assistantName: input.assistantName,
  });
  if (!decision.react) {
    return { kind: 'skipped', skipReason: decision.skippedBy };
  }
  const payload: ReactToMessageIpcPayload = {
    type: 'react_to_message',
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    sessionName: input.sessionName,
    emoji: REACT_FIRST_DEFAULT_EMOJI,
    timestamp: now().toISOString(),
  };
  try {
    ipcWriter(payload);
  } catch (err) {
    const errno = isExpectedIpcWriteError(err);
    if (errno === null) {
      throw err;
    }
    return {
      kind: 'ipc-failed',
      emoji: REACT_FIRST_DEFAULT_EMOJI,
      code: errno.code ?? 'UNKNOWN',
      message: errno.message,
    };
  }
  return { kind: 'emitted', emoji: REACT_FIRST_DEFAULT_EMOJI };
}
