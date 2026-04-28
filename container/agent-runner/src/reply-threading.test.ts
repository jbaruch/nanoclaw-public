import { describe, it, expect } from 'vitest';

import {
  applyReplyThreadingDecision,
  createReplyThreadingState,
  decideReplyThreading,
  extractLatestInboundId,
} from './reply-threading.js';

const TOOL = 'mcp__nanoclaw__send_message';

function baseState(overrides: { latestInboundId?: string | null; repliedToInbound?: boolean } = {}) {
  return {
    latestInboundId:
      'latestInboundId' in overrides ? (overrides.latestInboundId ?? null) : 'msg_42',
    repliedToInbound: overrides.repliedToInbound ?? false,
  };
}

describe('decideReplyThreading', () => {
  it('passes for non-send_message tools', () => {
    const decision = decideReplyThreading({
      toolName: 'mcp__nanoclaw__react_to_message',
      toolInput: { emoji: '👀' },
      isMaintenanceSession: false,
      state: baseState(),
    });
    expect(decision).toEqual({ kind: 'pass' });
  });

  it('passes for maintenance session', () => {
    expect(
      decideReplyThreading({
        toolName: TOOL,
        toolInput: { text: 'standalone' },
        isMaintenanceSession: true,
        state: baseState(),
      }),
    ).toEqual({ kind: 'pass' });
  });

  it('passes when pin is true', () => {
    expect(
      decideReplyThreading({
        toolName: TOOL,
        toolInput: { text: 'daily brief', pin: true },
        isMaintenanceSession: false,
        state: baseState(),
      }),
    ).toEqual({ kind: 'pass' });
  });

  it('passes when sender is set (multi-bot persona)', () => {
    expect(
      decideReplyThreading({
        toolName: TOOL,
        toolInput: { text: 'persona msg', sender: 'Researcher' },
        isMaintenanceSession: false,
        state: baseState(),
      }),
    ).toEqual({ kind: 'pass' });
  });

  it('returns mark-replied when reply_to is set', () => {
    const decision = decideReplyThreading({
      toolName: TOOL,
      toolInput: { text: 'hi', reply_to: 'msg_42' },
      isMaintenanceSession: false,
      state: baseState(),
    });
    expect(decision).toEqual({ kind: 'mark-replied' });
  });

  it('passes when no latest inbound is recorded', () => {
    expect(
      decideReplyThreading({
        toolName: TOOL,
        toolInput: { text: 'hi' },
        isMaintenanceSession: false,
        state: baseState({ latestInboundId: null }),
      }),
    ).toEqual({ kind: 'pass' });
  });

  it('passes when the inbound has already been replied this turn', () => {
    expect(
      decideReplyThreading({
        toolName: TOOL,
        toolInput: { text: 'follow-up' },
        isMaintenanceSession: false,
        state: baseState({ repliedToInbound: true }),
      }),
    ).toEqual({ kind: 'pass' });
  });

  it('denies a standalone send_message when the inbound is unanswered', () => {
    const decision = decideReplyThreading({
      toolName: TOOL,
      toolInput: { text: 'standalone reply' },
      isMaintenanceSession: false,
      state: baseState(),
    });
    expect(decision.kind).toBe('deny');
    if (decision.kind !== 'deny') throw new Error('unreachable');
    expect(decision.reason).toContain('msg_42');
    expect(decision.reason).toContain('reply_to');
  });

  it('handles missing tool_input gracefully', () => {
    const decision = decideReplyThreading({
      toolName: TOOL,
      toolInput: undefined,
      isMaintenanceSession: false,
      state: baseState(),
    });
    expect(decision.kind).toBe('deny');
  });
});

describe('applyReplyThreadingDecision', () => {
  it('flips repliedToInbound on mark-replied', () => {
    const state = createReplyThreadingState();
    state.latestInboundId = 'msg_1';
    applyReplyThreadingDecision(state, { kind: 'mark-replied' });
    expect(state.repliedToInbound).toBe(true);
  });

  it('does not change state on pass', () => {
    const state = createReplyThreadingState();
    state.latestInboundId = 'msg_1';
    applyReplyThreadingDecision(state, { kind: 'pass' });
    expect(state.repliedToInbound).toBe(false);
  });

  it('does not change state on deny', () => {
    const state = createReplyThreadingState();
    state.latestInboundId = 'msg_1';
    applyReplyThreadingDecision(state, { kind: 'deny', reason: 'x' });
    expect(state.repliedToInbound).toBe(false);
  });
});

describe('extractLatestInboundId', () => {
  it('returns the last id in a multi-message prompt', () => {
    const prompt = `<context timezone="UTC" />
<messages>
<message id="msg_1" sender="Baruch" time="10:00">first</message>
<message id="msg_2" sender="Baruch" time="10:05">second</message>
<message id="msg_3" sender="Baruch" time="10:10">latest</message>
</messages>`;
    expect(extractLatestInboundId(prompt)).toBe('msg_3');
  });

  it('returns the single id when only one is present', () => {
    expect(
      extractLatestInboundId('<message id="msg_42" sender="x">hi</message>'),
    ).toBe('msg_42');
  });

  it('returns null when no <message id> tag is present', () => {
    expect(extractLatestInboundId('plain text prompt')).toBe(null);
  });

  it('returns null for non-string input', () => {
    expect(extractLatestInboundId(undefined)).toBe(null);
    expect(extractLatestInboundId(42)).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(extractLatestInboundId('')).toBe(null);
  });

  it('handles attribute order variations', () => {
    expect(
      extractLatestInboundId('<message sender="x" id="msg_99" time="t">hi</message>'),
    ).toBe('msg_99');
  });
});

describe('createReplyThreadingState', () => {
  it('returns a fresh empty state', () => {
    expect(createReplyThreadingState()).toEqual({
      latestInboundId: null,
      repliedToInbound: false,
    });
  });
});

describe('integration — single turn lifecycle', () => {
  it('allows one threaded reply, then allows follow-ups', () => {
    const state = createReplyThreadingState();
    state.latestInboundId = extractLatestInboundId(
      '<message id="msg_777" sender="Baruch" time="t">do the thing</message>',
    );
    expect(state.latestInboundId).toBe('msg_777');

    // First call: standalone — denied
    const denied = decideReplyThreading({
      toolName: TOOL,
      toolInput: { text: 'starting' },
      isMaintenanceSession: false,
      state,
    });
    expect(denied.kind).toBe('deny');
    applyReplyThreadingDecision(state, denied);
    expect(state.repliedToInbound).toBe(false);

    // Second call: agent corrects with reply_to — allowed + marks
    const replied = decideReplyThreading({
      toolName: TOOL,
      toolInput: { text: 'on it', reply_to: 'msg_777' },
      isMaintenanceSession: false,
      state,
    });
    expect(replied.kind).toBe('mark-replied');
    applyReplyThreadingDecision(state, replied);
    expect(state.repliedToInbound).toBe(true);

    // Third call: standalone follow-up — now allowed
    const followUp = decideReplyThreading({
      toolName: TOOL,
      toolInput: { text: 'done' },
      isMaintenanceSession: false,
      state,
    });
    expect(followUp.kind).toBe('pass');
  });
});
