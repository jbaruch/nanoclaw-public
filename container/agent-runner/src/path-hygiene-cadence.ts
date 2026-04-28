/**
 * path-hygiene-cadence — pure helpers for the
 * `path-hygiene-cadence` PreToolUse hook (#139).
 *
 * Heartbeat (and other scheduled scans) sometimes detect persistent
 * path-hygiene issues — same files in wrong locations, same staging
 * drift, same orphaned drafts — and re-report them on every tick.
 * The user explicitly asked: don't re-report the same issue within
 * ~4 hours. The previous solution lived in personal-memory; memory
 * is advisory and gets ignored under load. The hook makes the
 * cadence deterministic.
 *
 * Decomposition:
 *  - `extractHygieneSignatures(text)` — pulls a stable identifier per
 *    distinct issue (path + keyword) out of an outbound message.
 *  - `decideHygieneCadence({...})` — given the current message's
 *    signatures and a lookup of "when each signature was last
 *    reported", decides pass / deny.
 *
 * The lookup is supplied by the caller in `index.ts`, which scans
 * the per-group daily logs (`/workspace/group/daily/<YYYY-MM-DD>.md`)
 * for prior reports. Keeping the file-IO out of this module keeps it
 * SDK-free and unit-testable.
 */

export interface HygieneSignature {
  /**
   * Stable identifier composed of `<keyword>:<path>` (lower-cased).
   * Two reports with the same signature are treated as duplicates;
   * different signatures (different file path *or* different issue
   * type) pass through independently.
   */
  signature: string;
  /** The keyword that classified this as hygiene content. */
  keyword: string;
  /** The file/dir path the keyword references. */
  path: string;
}

export type SignatureLookup = (signature: string) => number | undefined;

export interface HygieneCadenceInput {
  text: string;
  /** Returns "ms-since-epoch" of the last time `signature` was seen, or undefined. */
  lookupLastReportedAtMs: SignatureLookup;
  /** Current wall-clock timestamp in ms-since-epoch. */
  nowMs: number;
  /** Cadence window in ms (default: 4h). */
  windowMs?: number;
}

export type HygieneCadenceDecision =
  | { kind: 'pass'; reason: 'no-hygiene-content' | 'all-fresh' }
  | { kind: 'deny'; reason: string; suppressed: HygieneSignature[] };

/**
 * Default cadence window — 4 hours. Tunable per container if a
 * future config knob ever exposes it.
 */
export const DEFAULT_HYGIENE_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Hygiene-context keywords. Each one gates a single-keyword classifier
 * rather than a phrase one — matching by keyword alone keeps the regex
 * simple and false positives manageable. The catalogue mirrors the
 * issue's spec: "path hygiene", "orphaned", "misplaced", "staging
 * drift", plus the variants the model emits.
 */
const KEYWORD_PATTERNS: { keyword: string; pattern: RegExp }[] = [
  { keyword: 'path-hygiene', pattern: /\bpath[\s-]?hygiene\b/i },
  { keyword: 'orphaned', pattern: /\borphan(?:ed|s)?\b/i },
  { keyword: 'misplaced', pattern: /\bmisplaced?\b/i },
  { keyword: 'staging-drift', pattern: /\bstaging[\s-]?drift\b/i },
];

/**
 * Path-shape extractor. Captures absolute Linux paths (`/workspace/...`,
 * `/tmp/...`, `/home/...`) and relative paths with at least one `/`.
 * Keeps things narrow — bare filenames without a slash don't count,
 * since they produce too many spurious matches inside normal prose.
 *
 * The lookbehind `(?<=^|[\s(:'"\[])` lets us match a leading `/`
 * without losing it the way `\b/` would (`/` is not a word char, so
 * `\b/` only matches mid-word). Trailing punctuation (`. , ; :`) is
 * trimmed by the caller via `.replace(/[.,;:!?]+$/, '')` so a
 * sentence-final period doesn't get glued onto the path.
 */
const PATH_RE = /(?<=^|[\s(:'"\[])(?:\/[A-Za-z0-9_.@\-/]+|[A-Za-z0-9_.@\-]+\/[A-Za-z0-9_.@\-/]+)/g;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/**
 * Extract hygiene signatures from a message body.
 *
 * Algorithm:
 *  1. Find every keyword hit in the text.
 *  2. Find every path hit in the text.
 *  3. Cross-product: each keyword paired with each path produces one
 *     signature. (We don't try to associate a path with the *closest*
 *     keyword — proximity heuristics overfit. Cross-product means
 *     that a single message reporting two distinct issues per path
 *     dedupe per (issue, path) tuple.)
 *
 * No keywords or no paths → returns []. Caller treats empty as
 * "not hygiene content; pass".
 */
export function extractHygieneSignatures(
  text: unknown,
): HygieneSignature[] {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }
  const keywords = KEYWORD_PATTERNS.filter((k) => k.pattern.test(text)).map(
    (k) => k.keyword,
  );
  if (keywords.length === 0) {
    return [];
  }
  const rawPaths = text.match(PATH_RE) ?? [];
  const paths = Array.from(
    new Set(rawPaths.map((p) => p.replace(TRAILING_PUNCT_RE, ''))),
  ).filter((p) => p.length >= 3);
  if (paths.length === 0) {
    return [];
  }
  const sigs: HygieneSignature[] = [];
  for (const keyword of keywords) {
    for (const p of paths) {
      const norm = p.toLowerCase();
      sigs.push({
        signature: `${keyword}:${norm}`,
        keyword,
        path: p,
      });
    }
  }
  return sigs;
}

/**
 * Decide whether the cadence hook should deny this send_message.
 *
 * Logic:
 *  1. Extract signatures from the text. None → pass (`no-hygiene-content`).
 *  2. For each signature, look up its last-reported timestamp.
 *  3. If any signature's last report is within `windowMs`, deny.
 *  4. Else pass (`all-fresh`). Caller is responsible for recording
 *     each pass-through signature into its lookup so the next tick
 *     in the window suppresses correctly.
 */
export function decideHygieneCadence(
  input: HygieneCadenceInput,
): HygieneCadenceDecision {
  const window = input.windowMs ?? DEFAULT_HYGIENE_WINDOW_MS;
  const sigs = extractHygieneSignatures(input.text);
  if (sigs.length === 0) {
    return { kind: 'pass', reason: 'no-hygiene-content' };
  }
  const suppressed: HygieneSignature[] = [];
  for (const sig of sigs) {
    const lastMs = input.lookupLastReportedAtMs(sig.signature);
    if (lastMs !== undefined && input.nowMs - lastMs < window) {
      suppressed.push(sig);
    }
  }
  if (suppressed.length === 0) {
    return { kind: 'pass', reason: 'all-fresh' };
  }
  // If ANY signature is fresh and at least one is suppressed, the
  // safest call is still to deny: the message is probably reporting
  // a stale set with one new entry mixed in, which is exactly the
  // pattern the rule wanted to throttle. The agent can re-emit a
  // tighter message containing only the new entry.
  const summary = suppressed
    .map((s) => `${s.keyword} ${s.path}`)
    .join(', ');
  const windowLabel = formatWindowLabel(window);
  return {
    kind: 'deny',
    suppressed,
    reason:
      `Hygiene cadence: already reported within the last ${windowLabel} — ${summary}. ` +
      'Re-emit only with NEW issues, or pass `pin: true` to override for an explicit user request.',
  };
}

/**
 * Render a millisecond window as a short human label for deny
 * messages. Hours when ≥1h, minutes otherwise. Avoids hard-coding
 * "4h" so a custom `windowMs` doesn't lie in the deny reason.
 */
function formatWindowLabel(windowMs: number): string {
  const hours = windowMs / 3_600_000;
  if (hours >= 1) {
    const rounded = Math.round(hours * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toString()}h`;
  }
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  return `${minutes}min`;
}
