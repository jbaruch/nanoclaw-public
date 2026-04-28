/**
 * reply-threading — pure decision logic for the
 * `reply-threading-enforcement` PreToolUse hook (#137).
 *
 * When a user sends a message and Andy starts working on it, the
 * agent sometimes mid-turn emits a `send_message` **without
 * `reply_to`** — a standalone message that lands at the bottom of the
 * chat instead of as a quoted reply. In active threads (multiple
 * users, parallel topics) this looks like Andy answering a different
 * question, or talking to itself.
 *
 * The intended runtime contract is "single-turn": within the agent
 * loop, after a user inbound is recorded as the latest, the FIRST
 * `send_message` to that chat must thread to it (or be flagged as a
 * pin / dedicated-bot persona). Subsequent calls in the same turn can
 * be standalone — by then the inbound is "addressed".
 *
 * Cross-turn de-duplication (the "bot already spoke since this
 * inbound" carve-out for multi-user chats) is intentionally out of
 * scope for this initial cut. Doing it right requires a SQL query
 * against the mounted `messages.db`, which adds a native sqlite
 * dependency to the agent-runner and a container rebuild. The
 * in-process single-turn check catches the recurring "standalone
 * mid-turn" bug class without that footprint.
 *
 * Kept SDK-free so the root vitest can exercise it without spinning
 * up `@anthropic-ai/claude-agent-sdk`.
 */

export interface ReplyThreadingState {
  /**
   * Message ID of the most-recent user inbound that this turn was
   * triggered by. Populated by `extractLatestInboundId` from the
   * `UserPromptSubmit` prompt text. `null` when the prompt carries no
   * `<message id="...">` tag (scheduled task, owner-typed text, etc.).
   */
  latestInboundId: string | null;
  /**
   * Has the bot reply-threaded against `latestInboundId` in this
   * `runQuery()` lifetime? Flips true exclusively on a
   * `send_message` whose `reply_to` is set (any value — see decision
   * tree note 5). Pin / sender / maintenance carve-outs pass through
   * but do NOT flip this flag, because they don't establish thread
   * continuity for the user.
   *
   * After this flips true, subsequent `send_message` calls are
   * unconditionally allowed — by then the inbound is "addressed" and
   * follow-up output (multi-part replies, status updates) shouldn't
   * be gated.
   */
  repliedToInbound: boolean;
}

export interface ReplyThreadingInput {
  /** Tool name as the SDK reports it. */
  toolName: string;
  /** Raw `tool_input` from the PreToolUse hook. */
  toolInput: unknown;
  /** Whether this container is the maintenance / scheduled session. */
  isMaintenanceSession: boolean;
  /** Current per-turn threading state (mutated by `applyReplyThreadingDecision`). */
  state: ReplyThreadingState;
}

export type ReplyThreadingDecision =
  | { kind: 'pass' }
  | { kind: 'mark-replied' }
  | { kind: 'deny'; reason: string };

const SEND_MESSAGE_TOOL = 'mcp__nanoclaw__send_message';

interface SendMessageArgs {
  text?: unknown;
  reply_to?: unknown;
  sender?: unknown;
  pin?: unknown;
}

/**
 * Decide whether to deny a `send_message` PreToolUse call.
 *
 * Decision tree (early-exits at the first match):
 *  1. Not `mcp__nanoclaw__send_message` → pass (hook is no-op).
 *  2. Maintenance session (scheduled-task slot) → pass; reports
 *     emit independently of user threading.
 *  3. `pin: true` → pass; status updates / daily briefings explicitly
 *     bypass.
 *  4. `sender` set (multi-bot persona) → pass; persona messages have
 *     their own threading semantics in the renderer.
 *  5. `reply_to` set → pass *and* mark replied — this turn has
 *     addressed the latest inbound (regardless of which message id
 *     the agent reply-threaded to).
 *  6. No latest inbound recorded → pass; nothing to gate against.
 *  7. Inbound already replied this turn → pass.
 *  8. Otherwise → deny with the unanswered inbound id surfaced as a
 *     hint.
 */
export function decideReplyThreading(
  input: ReplyThreadingInput,
): ReplyThreadingDecision {
  if (input.toolName !== SEND_MESSAGE_TOOL) {
    return { kind: 'pass' };
  }
  if (input.isMaintenanceSession) {
    return { kind: 'pass' };
  }
  const args = (input.toolInput as SendMessageArgs | undefined) ?? {};
  if (args.pin === true) {
    return { kind: 'pass' };
  }
  if (typeof args.sender === 'string' && args.sender.length > 0) {
    return { kind: 'pass' };
  }
  if (typeof args.reply_to === 'string' && args.reply_to.length > 0) {
    return { kind: 'mark-replied' };
  }
  if (input.state.latestInboundId === null) {
    return { kind: 'pass' };
  }
  if (input.state.repliedToInbound) {
    return { kind: 'pass' };
  }
  return {
    kind: 'deny',
    reason:
      `Standalone send_message blocked: latest user inbound ` +
      `<id=${input.state.latestInboundId}> has no quoted reply yet. ` +
      `Pass \`reply_to: '${input.state.latestInboundId}'\` to thread, or ` +
      `set \`pin: true\` for a status update.`,
  };
}

/**
 * Side-effect: fold the decision back into the threading state. Caller
 * in `index.ts` invokes this after `decideReplyThreading` so that
 * subsequent calls in the same turn see the updated `repliedToInbound`
 * flag. Pure helper — does not mutate anything outside `state`.
 */
export function applyReplyThreadingDecision(
  state: ReplyThreadingState,
  decision: ReplyThreadingDecision,
): void {
  if (decision.kind === 'mark-replied') {
    state.repliedToInbound = true;
  }
}

/**
 * Extract the latest `<message id="...">` from a UserPromptSubmit
 * prompt body. The orchestrator wraps inbound user messages with
 * `<message id="..." sender="..." time="..." reply_to="...">CONTENT</message>`
 * (see `src/router.ts:formatMessages`); this helper finds the LAST
 * such id in the prompt — that's the message that triggered this turn.
 *
 * Returns `null` when no `<message id>` tag is present (scheduled
 * task, owner-typed text, slash commands, etc.). Caller treats `null`
 * as "no threading state to seed" — the threading hook simply passes.
 *
 * Note: we look for the LAST id, not the first, because a single
 * prompt may carry a back-context window of N messages plus the new
 * inbound at the end. The new inbound is always the trailing tag.
 */
export function extractLatestInboundId(prompt: unknown): string | null {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return null;
  }
  // Match <message ... id="..." ...> — the id attribute may appear
  // anywhere in the tag, so pull every match and take the last one.
  // The router emits id as the FIRST attribute today, but pinning to
  // attribute order would be brittle.
  const re = /<message\b[^>]*\bid="([^"]+)"/g;
  let lastId: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    lastId = m[1];
  }
  return lastId;
}

/**
 * Construct an empty per-turn threading state. Each new
 * `UserPromptSubmit` should reset state via this helper so the
 * "first send_message of the turn" rule applies fresh per inbound.
 */
export function createReplyThreadingState(): ReplyThreadingState {
  return { latestInboundId: null, repliedToInbound: false };
}
