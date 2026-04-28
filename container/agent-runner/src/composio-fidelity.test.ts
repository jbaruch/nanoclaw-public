import { describe, it, expect } from 'vitest';

import { detectComposioFidelity } from './composio-fidelity.js';

describe('detectComposioFidelity', () => {
  it('returns clean for null / empty / non-string input', () => {
    expect(detectComposioFidelity(null).fabricated).toBe(false);
    expect(detectComposioFidelity(undefined).fabricated).toBe(false);
    expect(detectComposioFidelity('').fabricated).toBe(false);
  });

  it('passes legitimate Composio results with hash-style ids', () => {
    const result = {
      messages: [
        { id: 'gmail_thread_a3f12c91d4', subject: 'Hello' },
        { id: 'gmail_thread_b7e29d40f1', subject: 'Hi' },
      ],
    };
    expect(detectComposioFidelity(result).fabricated).toBe(false);
  });

  it('flags 18 sequential email_NN ids — the heartbeat 2026-04-26 case', () => {
    const ids = Array.from({ length: 18 }, (_, i) =>
      `email_${String(i + 1).padStart(2, '0')}`,
    );
    const result = ids.map((id) => ({ id, subject: 'fake' }));
    const decision = detectComposioFidelity(result);
    expect(decision.fabricated).toBe(true);
    const finding = decision.findings.find(
      (f) => f.rule === 'sequential-prefix-ids',
    );
    expect(finding).toBeDefined();
    expect(finding!.count).toBe(18);
    expect(finding!.samples[0]).toBe('email_01');
  });

  it('flags 5 sequential task_001..005 ids (default minDistinctHits)', () => {
    const text = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({
        id: `task_${String(i + 1).padStart(3, '0')}`,
      })),
    );
    expect(detectComposioFidelity(text).fabricated).toBe(true);
  });

  it('does NOT flag 5 hash-suffix ids (not numeric)', () => {
    // Fixed deterministic suffixes — no Math.random(). The point of
    // the test is "non-numeric suffix shouldn't match the sequential
    // rule", and a stable fixture lets a future regression in the
    // suffix regex fail the same way every time.
    const result = JSON.stringify(
      [
        'task_a3f12c',
        'task_b7e29d',
        'task_4c8a01',
        'task_de51fa',
        'task_92b310',
      ].map((id) => ({ id })),
    );
    expect(detectComposioFidelity(result).fabricated).toBe(false);
  });

  it('does NOT flag 4 sequential ids — below threshold', () => {
    const result = JSON.stringify(
      ['email_01', 'email_02', 'email_03', 'email_04'].map((id) => ({ id })),
    );
    expect(detectComposioFidelity(result).fabricated).toBe(false);
  });

  it('does NOT flag 6 NON-sequential numeric ids', () => {
    const result = JSON.stringify(
      ['email_47', 'email_192', 'email_3', 'email_801', 'email_55', 'email_999'].map(
        (id) => ({ id }),
      ),
    );
    expect(detectComposioFidelity(result).fabricated).toBe(false);
  });

  it('flags pr_notif fabrication shape', () => {
    const result = JSON.stringify({
      notifications: [
        { id: 'pr1_notif' },
        { id: 'pr2_notif' },
        { id: 'pr3_notif' },
      ],
    });
    const decision = detectComposioFidelity(result);
    expect(decision.fabricated).toBe(true);
    expect(decision.findings.find((f) => f.rule === 'pr-notif-style')).toBeDefined();
  });

  it('flags promo_NNN fabrication shape', () => {
    const result = 'promo_001 promo_002 promo_003';
    const decision = detectComposioFidelity(result);
    expect(decision.fabricated).toBe(true);
    expect(decision.findings.find((f) => f.rule === 'promo-numbered')).toBeDefined();
  });

  it('reports multiple findings independently', () => {
    const text =
      JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({
          id: `email_${String(i + 1).padStart(2, '0')}`,
        })),
      ) + ' ' + 'pr1_notif pr2_notif pr3_notif';
    const decision = detectComposioFidelity(text);
    expect(decision.fabricated).toBe(true);
    expect(decision.findings.length).toBeGreaterThanOrEqual(2);
  });

  it('reinjection text mentions each rule + sample', () => {
    const ids = Array.from({ length: 6 }, (_, i) =>
      `event_${String(i + 1).padStart(2, '0')}`,
    );
    const decision = detectComposioFidelity(ids.join(' '));
    expect(decision.reinjection).toContain('sequential-prefix-ids');
    expect(decision.reinjection).toContain('event_01');
    expect(decision.reinjection).toContain('untrusted');
  });
});
