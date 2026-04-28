/**
 * silent-turn-audit — pure decision logic for the
 * `stop-hook-end-of-turn-audit` Stop hook (#142).
 *
 * The most insidious Andy failure mode: user sends a message, the
 * agent runs a turn, does work, exits — but never reacts to or
 * replies to the user's actual message. From the user's view it looks
 * like dropped silence; from the orchestrator's view the container
 * exited cleanly. There is no signal that anything went wrong unless
 * the user notices and complains.
 *
 * The hook is **observability only** — it does not block the turn.
 * On Stop, it inspects per-turn state collected during the run and,
 * if the triggering inbound was neither reacted to nor replied to,
 * appends a structured entry to `/workspace/host-logs/silent-turns.log`
 * for later investigation.
 *
 * Pure decomposition:
 *  - `createSilentTurnState()` — fresh state per runQuery.
 *  - `decideSilentTurnAudit({...})` — given the gathered state and
 *    skip flags, returns either `pass` (do nothing) or `log` (write
 *    the audit entry).
 *
 * Wiring lives in `index.ts`: PreToolUse callbacks update the state
 * for `react_to_message` / `send_message`; the Stop callback consults
 * `decideSilentTurnAudit` and writes the log file.
 *
 * Kept SDK-free so the root vitest can exercise it without spinning
 * up `@anthropic-ai/claude-agent-sdk`.
 */

export interface SilentTurnState {
  /**
   * The id of the user inbound that triggered this turn. `null` when
   * the turn was driven by something other than a user message
   * (scheduled task, orchestrator text, slash command).
   */
  triggeringInboundId: string | null;
  /**
   * Time the turn started, ms-since-epoch. Surfaced in the audit
   * entry so investigations can correlate with the messages db.
   */
  turnStartedAtMs: number;
  /** True iff a `react_to_message` call landed during the turn. */
  reactedToInbound: boolean;
  /**
   * True iff a `send_message` with `reply_to === triggeringInboundId`
   * landed during the turn. The "any send_message when no triggering
   * id was recorded" case is handled by `decideSilentTurnAudit`'s
   * `no-triggering-inbound` early-pass — turns without a triggering
   * inbound never reach the addressed-or-not check, so this flag
   * stays false on those.
   */
  repliedToInbound: boolean;
  /**
   * Any `send_message` at all — used for the
   * "agent shipped output but to nobody in particular" diagnostic.
   */
  anySendMessage: boolean;
}

export interface SilentTurnAuditInput {
  /** True iff the Stop fired inside a sub-agent. */
  isSubagent: boolean;
  /** True iff this container is the maintenance / scheduled session. */
  isMaintenanceSession: boolean;
  /** True iff this run was a scheduled task. */
  isScheduledTask: boolean;
  /** Per-turn state assembled by the wiring in `index.ts`. */
  state: SilentTurnState;
}

export type SilentTurnAuditDecision =
  | { kind: 'pass'; reason: 'subagent' | 'maintenance' | 'scheduled-task' | 'no-triggering-inbound' | 'addressed' }
  | {
      kind: 'log';
      record: {
        turnStartedAtMs: number;
        triggeringInboundId: string;
        reactedToInbound: boolean;
        repliedToInbound: boolean;
        anySendMessage: boolean;
      };
    };

export function createSilentTurnState(turnStartedAtMs: number): SilentTurnState {
  return {
    triggeringInboundId: null,
    turnStartedAtMs,
    reactedToInbound: false,
    repliedToInbound: false,
    anySendMessage: false,
  };
}

/**
 * Decide whether the Stop hook should write an audit entry.
 *
 * Skip the audit on every kind of turn that is not a real user
 * inbound:
 *  - Sub-agent stops (the parent turn is what gets audited).
 *  - Maintenance session (no human audience to go silent on).
 *  - Scheduled tasks (no triggering user message to react/reply to).
 *  - Turns with no recorded triggering inbound (orchestrator text,
 *    slash commands, etc.).
 *
 * On a real user-facing turn, write the log entry iff neither a
 * react nor a matching reply landed. Note: this is the bug class
 * we're trying to *catch*, so the recommended action is structured
 * logging, not blocking — the agent has already exited.
 */
export function decideSilentTurnAudit(
  input: SilentTurnAuditInput,
): SilentTurnAuditDecision {
  if (input.isSubagent) {
    return { kind: 'pass', reason: 'subagent' };
  }
  if (input.isMaintenanceSession) {
    return { kind: 'pass', reason: 'maintenance' };
  }
  if (input.isScheduledTask) {
    return { kind: 'pass', reason: 'scheduled-task' };
  }
  if (input.state.triggeringInboundId === null) {
    return { kind: 'pass', reason: 'no-triggering-inbound' };
  }
  if (input.state.reactedToInbound || input.state.repliedToInbound) {
    return { kind: 'pass', reason: 'addressed' };
  }
  return {
    kind: 'log',
    record: {
      turnStartedAtMs: input.state.turnStartedAtMs,
      triggeringInboundId: input.state.triggeringInboundId,
      reactedToInbound: input.state.reactedToInbound,
      repliedToInbound: input.state.repliedToInbound,
      anySendMessage: input.state.anySendMessage,
    },
  };
}
