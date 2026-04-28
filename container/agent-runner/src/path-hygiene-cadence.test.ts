import { describe, it, expect } from 'vitest';

import {
  DEFAULT_HYGIENE_WINDOW_MS,
  decideHygieneCadence,
  extractHygieneSignatures,
} from './path-hygiene-cadence.js';

describe('extractHygieneSignatures', () => {
  it('returns [] for empty / non-string input', () => {
    expect(extractHygieneSignatures('')).toEqual([]);
    expect(extractHygieneSignatures(undefined)).toEqual([]);
    expect(extractHygieneSignatures(42)).toEqual([]);
  });

  it('returns [] for prose without hygiene keywords', () => {
    expect(
      extractHygieneSignatures('All quiet — no issues to report. /workspace/group/RUNBOOK.md last touched 2h ago.'),
    ).toEqual([]);
  });

  it('returns [] when keywords are present but no paths', () => {
    expect(
      extractHygieneSignatures('Path hygiene check ran — clean.'),
    ).toEqual([]);
  });

  it('extracts a single signature for one keyword + one path', () => {
    const sigs = extractHygieneSignatures(
      'Path hygiene: /workspace/group/conversations/old.md is in the wrong place.',
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0].keyword).toBe('path-hygiene');
    expect(sigs[0].path).toBe('/workspace/group/conversations/old.md');
    expect(sigs[0].signature).toBe(
      'path-hygiene:/workspace/group/conversations/old.md',
    );
  });

  it('produces a cross-product of keywords × paths', () => {
    const sigs = extractHygieneSignatures(
      'Orphaned file /workspace/foo and misplaced staging/bar — staging drift again.',
    );
    const keys = sigs.map((s) => s.signature).sort();
    expect(keys).toEqual(
      [
        'misplaced:/workspace/foo',
        'misplaced:staging/bar',
        'orphaned:/workspace/foo',
        'orphaned:staging/bar',
        'staging-drift:/workspace/foo',
        'staging-drift:staging/bar',
      ].sort(),
    );
  });

  it('deduplicates repeated paths', () => {
    const sigs = extractHygieneSignatures(
      'Orphaned /a/b. Orphaned /a/b. Orphaned /a/b.',
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0].signature).toBe('orphaned:/a/b');
  });

  it('lowercases the path inside the signature for stable matching', () => {
    const sigs = extractHygieneSignatures(
      'Orphaned /Workspace/Group/Foo.md',
    );
    expect(sigs[0].signature).toBe('orphaned:/workspace/group/foo.md');
    expect(sigs[0].path).toBe('/Workspace/Group/Foo.md');
  });
});

describe('decideHygieneCadence', () => {
  const NOW = 1_750_000_000_000;
  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  it('passes (no-hygiene-content) when text has no signatures', () => {
    const decision = decideHygieneCadence({
      text: 'Just a status update.',
      lookupLastReportedAtMs: () => undefined,
      nowMs: NOW,
    });
    expect(decision.kind).toBe('pass');
    if (decision.kind === 'pass') {
      expect(decision.reason).toBe('no-hygiene-content');
    }
  });

  it('passes (all-fresh) when no signature has been seen', () => {
    const decision = decideHygieneCadence({
      text: 'Path hygiene: /workspace/foo is misplaced.',
      lookupLastReportedAtMs: () => undefined,
      nowMs: NOW,
    });
    expect(decision.kind).toBe('pass');
    if (decision.kind === 'pass') {
      expect(decision.reason).toBe('all-fresh');
    }
  });

  it('denies when a signature was reported within the window', () => {
    const decision = decideHygieneCadence({
      text: 'Path hygiene: /workspace/foo is misplaced.',
      // last reported 1h ago
      lookupLastReportedAtMs: (s) =>
        s === 'path-hygiene:/workspace/foo' ? NOW - 60 * 60 * 1000 : undefined,
      nowMs: NOW,
    });
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.suppressed).toHaveLength(1);
      expect(decision.reason).toContain('/workspace/foo');
    }
  });

  it('passes when the prior report is OLDER than the window', () => {
    const decision = decideHygieneCadence({
      text: 'Path hygiene: /workspace/foo is misplaced.',
      lookupLastReportedAtMs: () => NOW - FOUR_HOURS - 60_000,
      nowMs: NOW,
    });
    expect(decision.kind).toBe('pass');
  });

  it('denies even when only ONE of several signatures is stale', () => {
    const decision = decideHygieneCadence({
      text:
        'Orphaned /a/b. Orphaned /c/d.',
      lookupLastReportedAtMs: (s) =>
        s === 'orphaned:/a/b' ? NOW - 30 * 60 * 1000 : undefined,
      nowMs: NOW,
    });
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.suppressed.map((s) => s.signature)).toEqual([
        'orphaned:/a/b',
      ]);
      expect(decision.reason).toContain('/a/b');
    }
  });

  it('respects a custom windowMs', () => {
    const decision = decideHygieneCadence({
      text: 'Path hygiene: /workspace/foo orphaned.',
      lookupLastReportedAtMs: () => NOW - 30 * 60 * 1000,
      nowMs: NOW,
      windowMs: 10 * 60 * 1000, // 10 minutes; 30 minutes ago is outside
    });
    expect(decision.kind).toBe('pass');
  });

  it('renders the actual window in the deny reason (not hard-coded 4h)', () => {
    const decision = decideHygieneCadence({
      text: 'Path hygiene: /workspace/foo orphaned.',
      lookupLastReportedAtMs: () => NOW - 5 * 60 * 1000, // 5min ago
      nowMs: NOW,
      windowMs: 30 * 60 * 1000, // 30-minute custom window
    });
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.reason).toContain('30min');
      expect(decision.reason).not.toContain('4h');
    }
  });

  it('renders the default 4h window in the deny reason', () => {
    const decision = decideHygieneCadence({
      text: 'Path hygiene: /workspace/foo orphaned.',
      lookupLastReportedAtMs: () => NOW - 60 * 60 * 1000,
      nowMs: NOW,
    });
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.reason).toContain('4h');
    }
  });

  it('exposes the default 4h window constant', () => {
    expect(DEFAULT_HYGIENE_WINDOW_MS).toBe(FOUR_HOURS);
  });
});
