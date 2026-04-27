import { describe, it, expect } from 'vitest';

import {
  normalizeReactionEmoji,
  _isAllowedReaction,
  _EMOJI_SHORTCODE_TO_UNICODE,
} from './telegram.js';

describe('normalizeReactionEmoji — passthrough for valid Unicode', () => {
  it('passes Unicode reactions through unchanged', () => {
    // Already-Unicode input must round-trip exactly so callers that
    // already do the right thing aren't penalized.
    expect(normalizeReactionEmoji('👍')).toBe('👍');
    expect(normalizeReactionEmoji('🤣')).toBe('🤣');
    expect(normalizeReactionEmoji('💯')).toBe('💯');
    expect(normalizeReactionEmoji('🤷')).toBe('🤷');
  });

  it('strips U+FE0F (variation selector 16) so emoji-presentation forms match', () => {
    // Common emoji have two encodings: bare codepoint (`❤`, `☃`)
    // and a `+ U+FE0F` form for emoji presentation (`❤️`, `☃️`).
    // Telegram's reaction set uses the bare form; agents and clients
    // commonly emit the VS16 form. Without the strip these would
    // fail the .has() gate and fall back to 👍.
    expect(normalizeReactionEmoji('❤️')).toBe('❤');
    expect(normalizeReactionEmoji('☃️')).toBe('☃');
    expect(normalizeReactionEmoji('✍️')).toBe('✍');
    expect(normalizeReactionEmoji('🤷‍♂️')).toBe('🤷‍♂');
    expect(normalizeReactionEmoji('🤷‍♀️')).toBe('🤷‍♀');
    expect(normalizeReactionEmoji('🕊️')).toBe('🕊');
  });
});

describe('normalizeReactionEmoji — Slack-style shortcodes', () => {
  it('maps the shortcodes called out in #161 as already-working', () => {
    // These were reported as "Works via Slack shortcode" in the issue.
    // They must keep working through normalization (idempotent for
    // anything that already mapped on Telegram's side, but correctness
    // here doesn't depend on Telegram — we map locally).
    expect(normalizeReactionEmoji('thumbs_up')).toBe('👍');
    expect(normalizeReactionEmoji('thumbs_down')).toBe('👎');
    expect(normalizeReactionEmoji('heart')).toBe('❤');
    expect(normalizeReactionEmoji('fire')).toBe('🔥');
    expect(normalizeReactionEmoji('100')).toBe('💯');
    expect(normalizeReactionEmoji('eyes')).toBe('👀');
    expect(normalizeReactionEmoji('thinking_face')).toBe('🤔');
    expect(normalizeReactionEmoji('tada')).toBe('🎉');
    expect(normalizeReactionEmoji('sob')).toBe('😭');
    expect(normalizeReactionEmoji('clap')).toBe('👏');
    expect(normalizeReactionEmoji('trophy')).toBe('🏆');
    expect(normalizeReactionEmoji('pray')).toBe('🙏');
    expect(normalizeReactionEmoji('ok_hand')).toBe('👌');
    expect(normalizeReactionEmoji('zap')).toBe('⚡');
    expect(normalizeReactionEmoji('rage')).toBe('😡');
    expect(normalizeReactionEmoji('sleeping')).toBe('😴');
  });

  it('maps the shortcodes called out in #161 as Unicode-only', () => {
    // Sample from the "Works via Unicode only" list. Without the
    // mapping these would have failed `TELEGRAM_ALLOWED_REACTIONS.has`
    // and silently fallen back to 👍. The map has to cover them.
    expect(normalizeReactionEmoji('rofl')).toBe('🤣');
    expect(normalizeReactionEmoji('exploding_head')).toBe('🤯');
    expect(normalizeReactionEmoji('heart_eyes')).toBe('😍');
    expect(normalizeReactionEmoji('scream')).toBe('😱');
    expect(normalizeReactionEmoji('vomit')).toBe('🤮');
    expect(normalizeReactionEmoji('poop')).toBe('💩');
    expect(normalizeReactionEmoji('clown')).toBe('🤡');
    expect(normalizeReactionEmoji('broken_heart')).toBe('💔');
    expect(normalizeReactionEmoji('ghost')).toBe('👻');
    expect(normalizeReactionEmoji('star_struck')).toBe('🤩');
    expect(normalizeReactionEmoji('nerd')).toBe('🤓');
    expect(normalizeReactionEmoji('hugs')).toBe('🤗');
    expect(normalizeReactionEmoji('salute')).toBe('🫡');
    expect(normalizeReactionEmoji('moai')).toBe('🗿');
    expect(normalizeReactionEmoji('santa')).toBe('🎅');
    expect(normalizeReactionEmoji('snowman')).toBe('☃');
    expect(normalizeReactionEmoji('zany')).toBe('🤪');
    expect(normalizeReactionEmoji('cool')).toBe('🆒');
    expect(normalizeReactionEmoji('cupid')).toBe('💘');
    expect(normalizeReactionEmoji('unicorn')).toBe('🦄');
    expect(normalizeReactionEmoji('pill')).toBe('💊');
    expect(normalizeReactionEmoji('kiss')).toBe('💋');
    expect(normalizeReactionEmoji('yawn')).toBe('🥱');
  });
});

describe('normalizeReactionEmoji — colon-delimited shortcodes', () => {
  it('strips surrounding colons (Slack format)', () => {
    expect(normalizeReactionEmoji(':thumbs_up:')).toBe('👍');
    expect(normalizeReactionEmoji(':rofl:')).toBe('🤣');
    expect(normalizeReactionEmoji(':100:')).toBe('💯');
  });

  it('handles aliases that already include a digit', () => {
    expect(normalizeReactionEmoji('+1')).toBe('👍');
    expect(normalizeReactionEmoji('-1')).toBe('👎');
  });
});

describe('normalizeReactionEmoji — unmapped input', () => {
  it('returns input unchanged for unknown shortcodes', () => {
    // Caller's `TELEGRAM_ALLOWED_REACTIONS.has(...)` gate handles
    // the actual fallback to 👍 with a warn log. Returning the
    // original lets that gate emit a useful diagnostic instead of
    // collapsing to 👍 silently here.
    expect(normalizeReactionEmoji('unknown_shortcode')).toBe(
      'unknown_shortcode',
    );
    expect(normalizeReactionEmoji('not_a_real_emoji')).toBe('not_a_real_emoji');
  });

  it('returns input unchanged for inherited Object.prototype keys (no proto pollution)', () => {
    // Indexing a plain object with `toString`, `__proto__`, etc.
    // returns inherited values from Object.prototype unless guarded.
    // The own-property check must keep these falling through to the
    // input-unchanged path. Without the guard `__proto__` would
    // return `[object Object]` and `toString` would return a
    // function reference — both violations of the string return.
    expect(normalizeReactionEmoji('toString')).toBe('toString');
    expect(normalizeReactionEmoji('__proto__')).toBe('__proto__');
    expect(normalizeReactionEmoji('hasOwnProperty')).toBe('hasOwnProperty');
    expect(normalizeReactionEmoji('constructor')).toBe('constructor');
  });

  it('returns input unchanged for unsupported Unicode (issue #161 not_supported list)', () => {
    // These were reported as "Not supported at all" — Telegram has
    // no reaction slot for them. The normalizer should NOT fabricate
    // a mapping; the caller's allowed-reactions gate falls back.
    expect(normalizeReactionEmoji('✅')).toBe('✅');
    expect(normalizeReactionEmoji('🚀')).toBe('🚀');
    expect(normalizeReactionEmoji('🤦')).toBe('🤦');
  });
});

// --- Invariant: every shortcode-map value MUST be in the allowed set ---
//
// Drift between EMOJI_SHORTCODE_TO_UNICODE and TELEGRAM_ALLOWED_REACTIONS
// is the failure mode this normalization is supposed to PREVENT — a
// shortcode that maps to a Unicode char Telegram doesn't accept would
// still fall back to 👍, just at a different gate. Test exhaustively by
// iterating every entry of the actual map (exposed via @internal export)
// and asserting each value clears the production allowed-reactions
// predicate.

describe('drift invariant — every shortcode maps to a Telegram-allowed reaction', () => {
  // Iterating Object.entries directly exposes any future addition to
  // EMOJI_SHORTCODE_TO_UNICODE the moment it lands. A hardcoded list
  // here would have to be updated alongside, defeating the point of
  // the invariant.
  for (const [shortcode, unicode] of Object.entries(
    _EMOJI_SHORTCODE_TO_UNICODE,
  )) {
    it(`'${shortcode}' → '${unicode}' is in TELEGRAM_ALLOWED_REACTIONS`, () => {
      expect(_isAllowedReaction(unicode)).toBe(true);
    });
  }

  it('every shortcode-mapped Unicode round-trips through normalizeReactionEmoji unchanged', () => {
    // After mapping, the result must itself be a normalize fixed
    // point — feeding the Unicode value back in should hit the
    // first-branch short-circuit and return unchanged. Catches a
    // map-table bug where someone wrote a non-canonical form that
    // would re-enter the shortcode lookup loop.
    for (const unicode of Object.values(_EMOJI_SHORTCODE_TO_UNICODE)) {
      expect(normalizeReactionEmoji(unicode)).toBe(unicode);
    }
  });
});
