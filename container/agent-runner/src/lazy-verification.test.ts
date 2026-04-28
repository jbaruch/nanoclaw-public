import { describe, it, expect } from 'vitest';

import {
  LAZY_VERIFICATION_PHRASE_LABELS,
  detectLazyVerification,
} from './lazy-verification.js';

describe('detectLazyVerification', () => {
  describe('catches each catalogued excuse', () => {
    const samples: Record<string, string> = {
      'site-is-js-rendered':
        'I checked but the site is JS-rendered so the contents are blank.',
      'page-is-thin':
        'Looked at the URL — page is almost empty without manual interaction.',
      'cant-access-this':
        'Sorry, I cannot access this URL from my environment.',
      'cant-read-this-site':
        'I am unable to read the page directly without browser support.',
      'couldnt-load-the-page':
        'The fetch returned nothing useful — failed to load the page.',
      'content-loads-dynamically':
        'Most of the content is loaded dynamically by client-side JS.',
    };
    for (const [label, sample] of Object.entries(samples)) {
      it(`flags "${label}"`, () => {
        const decision = detectLazyVerification(sample);
        expect(decision.block).toBe(true);
        expect(decision.matches.map((m) => m.phrase)).toContain(label);
        expect(decision.reinjection).toContain(label);
      });
    }
  });

  it('passes through clean output', () => {
    const decision = detectLazyVerification(
      'The CFP deadline is 2026-06-01, confirmed via the Sessionize API.',
    );
    expect(decision.block).toBe(false);
    expect(decision.matches).toHaveLength(0);
    expect(decision.passReason).toBe('no-match');
  });

  it('passes through when the agent enumerated genuine failures', () => {
    const message = [
      'Could not verify the deadline.',
      'Tried the Cloudflare browser tool — got an empty <body>.',
      'Tried the Sessionize API — 404, event is not on Sessionize.',
      'Falling back to manual confirmation: site is JS-rendered.',
    ].join(' ');
    const decision = detectLazyVerification(message);
    expect(decision.block).toBe(false);
    expect(decision.matches.length).toBeGreaterThan(0);
    expect(decision.passReason).toBe('tried-enumeration-present');
  });

  it('still blocks when only one Tried statement is present', () => {
    const message =
      'Tried WebFetch — got an empty body. Site is JS-rendered.';
    const decision = detectLazyVerification(message);
    expect(decision.block).toBe(true);
  });

  it('catches multiple banned phrases in one message', () => {
    const message =
      'I cannot access this URL because the site is JS-rendered and the page is thin.';
    const decision = detectLazyVerification(message);
    expect(decision.block).toBe(true);
    const labels = decision.matches.map((m) => m.phrase);
    expect(labels).toContain('cant-access-this');
    expect(labels).toContain('site-is-js-rendered');
    expect(labels).toContain('page-is-thin');
  });

  it('returns a snippet around the matched span', () => {
    const message =
      'After trying WebFetch I gave up because the site is JS-rendered with no fallback.';
    const decision = detectLazyVerification(message);
    expect(decision.matches[0].snippet).toContain('JS-rendered');
  });

  describe('input shape', () => {
    it('returns no-block for non-string', () => {
      expect(detectLazyVerification(undefined).block).toBe(false);
      expect(detectLazyVerification(42).block).toBe(false);
    });
    it('returns no-block for empty string', () => {
      expect(detectLazyVerification('').block).toBe(false);
    });
  });

  it('exposes a stable phrase-label catalogue', () => {
    expect(LAZY_VERIFICATION_PHRASE_LABELS).toEqual([
      'site-is-js-rendered',
      'page-is-thin',
      'cant-access-this',
      'cant-read-this-site',
      'couldnt-load-the-page',
      'content-loads-dynamically',
    ]);
  });
});
