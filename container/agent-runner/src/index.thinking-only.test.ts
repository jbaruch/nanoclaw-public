import { describe, it, expect } from 'vitest';
import { isThinkingOnlyEndTurn } from './index.js';

describe('isThinkingOnlyEndTurn — pseudo-turn detection', () => {
  it('detects a turn that is only thinking + end_turn', () => {
    expect(isThinkingOnlyEndTurn('end_turn', ['thinking'])).toBe(true);
  });

  it('detects multiple thinking blocks + end_turn', () => {
    expect(isThinkingOnlyEndTurn('end_turn', ['thinking', 'thinking'])).toBe(
      true,
    );
  });

  it('detects redacted_thinking blocks alongside thinking', () => {
    expect(
      isThinkingOnlyEndTurn('end_turn', ['thinking', 'redacted_thinking']),
    ).toBe(true);
  });

  it('detects only-redacted_thinking + end_turn', () => {
    expect(isThinkingOnlyEndTurn('end_turn', ['redacted_thinking'])).toBe(true);
  });

  it('does NOT trigger when stop_reason is not end_turn', () => {
    expect(isThinkingOnlyEndTurn('tool_use', ['thinking'])).toBe(false);
    expect(isThinkingOnlyEndTurn('max_tokens', ['thinking'])).toBe(false);
    expect(isThinkingOnlyEndTurn(undefined, ['thinking'])).toBe(false);
  });

  it('does NOT trigger when text blocks are present', () => {
    expect(isThinkingOnlyEndTurn('end_turn', ['thinking', 'text'])).toBe(false);
    expect(isThinkingOnlyEndTurn('end_turn', ['text'])).toBe(false);
  });

  it('does NOT trigger when tool_use blocks are present', () => {
    expect(isThinkingOnlyEndTurn('end_turn', ['thinking', 'tool_use'])).toBe(
      false,
    );
  });

  it('does NOT trigger on an empty block list (defensive)', () => {
    // A turn with zero content blocks is an SDK-shape edge case during
    // certain error paths — explicitly NOT the "model decided to say
    // nothing" pseudo-turn we're targeting. Falling back to a previous
    // turn there would be an over-reach.
    expect(isThinkingOnlyEndTurn('end_turn', [])).toBe(false);
  });

  it('readonly array argument is accepted', () => {
    const blocks: readonly string[] = ['thinking'];
    expect(isThinkingOnlyEndTurn('end_turn', blocks)).toBe(true);
  });
});
