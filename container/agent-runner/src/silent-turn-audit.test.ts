import { describe, it, expect } from 'vitest';

import {
  createSilentTurnState,
  decideSilentTurnAudit,
} from './silent-turn-audit.js';

const NOW = 1_750_000_000_000;

function baseInput(overrides: Partial<{
  isSubagent: boolean;
  isMaintenanceSession: boolean;
  isScheduledTask: boolean;
  triggeringInboundId: string | null;
  reactedToInbound: boolean;
  repliedToInbound: boolean;
  anySendMessage: boolean;
}> = {}) {
  const state = createSilentTurnState(NOW);
  state.triggeringInboundId =
    'triggeringInboundId' in overrides ? (overrides.triggeringInboundId ?? null) : 'msg_77';
  state.reactedToInbound = overrides.reactedToInbound ?? false;
  state.repliedToInbound = overrides.repliedToInbound ?? false;
  state.anySendMessage = overrides.anySendMessage ?? false;
  return {
    isSubagent: overrides.isSubagent ?? false,
    isMaintenanceSession: overrides.isMaintenanceSession ?? false,
    isScheduledTask: overrides.isScheduledTask ?? false,
    state,
  };
}

describe('decideSilentTurnAudit', () => {
  it('logs when neither react nor reply landed', () => {
    const decision = decideSilentTurnAudit(baseInput());
    expect(decision.kind).toBe('log');
    if (decision.kind !== 'log') throw new Error('unreachable');
    expect(decision.record.triggeringInboundId).toBe('msg_77');
    expect(decision.record.reactedToInbound).toBe(false);
    expect(decision.record.repliedToInbound).toBe(false);
  });

  it('passes when the inbound was reacted to', () => {
    const decision = decideSilentTurnAudit(
      baseInput({ reactedToInbound: true }),
    );
    expect(decision.kind).toBe('pass');
    if (decision.kind === 'pass') {
      expect(decision.reason).toBe('addressed');
    }
  });

  it('passes when the inbound was replied to', () => {
    const decision = decideSilentTurnAudit(
      baseInput({ repliedToInbound: true }),
    );
    expect(decision.kind).toBe('pass');
  });

  it('passes (subagent) on sub-agent turns', () => {
    const decision = decideSilentTurnAudit(baseInput({ isSubagent: true }));
    expect(decision.kind).toBe('pass');
    if (decision.kind === 'pass') {
      expect(decision.reason).toBe('subagent');
    }
  });

  it('passes (maintenance) on the maintenance session', () => {
    const decision = decideSilentTurnAudit(
      baseInput({ isMaintenanceSession: true }),
    );
    expect(decision.kind).toBe('pass');
    if (decision.kind === 'pass') {
      expect(decision.reason).toBe('maintenance');
    }
  });

  it('passes (scheduled-task) on scheduled-task turns', () => {
    const decision = decideSilentTurnAudit(
      baseInput({ isScheduledTask: true }),
    );
    expect(decision.kind).toBe('pass');
    if (decision.kind === 'pass') {
      expect(decision.reason).toBe('scheduled-task');
    }
  });

  it('passes (no-triggering-inbound) when no inbound was recorded', () => {
    const decision = decideSilentTurnAudit(
      baseInput({ triggeringInboundId: null }),
    );
    expect(decision.kind).toBe('pass');
    if (decision.kind === 'pass') {
      expect(decision.reason).toBe('no-triggering-inbound');
    }
  });

  it('subagent gate beats addressed', () => {
    const decision = decideSilentTurnAudit(
      baseInput({ isSubagent: true, reactedToInbound: true }),
    );
    expect(decision.kind).toBe('pass');
    if (decision.kind === 'pass') {
      expect(decision.reason).toBe('subagent');
    }
  });

  it('records anySendMessage in the audit log', () => {
    const decision = decideSilentTurnAudit(
      baseInput({ anySendMessage: true }),
    );
    expect(decision.kind).toBe('log');
    if (decision.kind !== 'log') throw new Error('unreachable');
    expect(decision.record.anySendMessage).toBe(true);
  });
});

describe('createSilentTurnState', () => {
  it('returns a fresh state with the supplied start time', () => {
    const state = createSilentTurnState(NOW);
    expect(state).toEqual({
      triggeringInboundId: null,
      turnStartedAtMs: NOW,
      reactedToInbound: false,
      repliedToInbound: false,
      anySendMessage: false,
    });
  });
});
