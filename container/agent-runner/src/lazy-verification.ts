/**
 * lazy-verification — pure detection logic for the
 * `lazy-verification-detector` Stop hook (#135).
 *
 * The agent has a `nanoclaw-core/rules/no-lazy-verification.md` rule
 * that bans a specific catalogue of excuse phrases ("site is JS-
 * rendered", "page is thin / almost empty", "can't access this", etc.)
 * because each one collapses the moment the agent launches a real
 * browser tool, hits a domain API, or runs code. Rules are advisory;
 * the model under load surfaces these excuses anyway. The hook
 * detects them deterministically.
 *
 * Detection has a single carve-out: an "enumerated failure" shape
 * (`Tried <X> — got <Y>; tried <A> — got <B>`) is the rule-allowed
 * way to report that verification was actually attempted. When that
 * shape is present, the banned phrase is treated as legitimate and
 * the message is allowed through.
 *
 * Kept SDK-free so the root vitest can exercise it without spinning
 * up `@anthropic-ai/claude-agent-sdk`.
 */

export interface LazyVerificationMatch {
  /** The banned phrase pattern that matched. */
  phrase: string;
  /** Excerpt from the message showing the matched span. */
  snippet: string;
}

export interface LazyVerificationDecision {
  /** True iff the Stop hook should block + reinject. */
  block: boolean;
  /**
   * All banned phrases found in the message. Empty when no pattern
   * matched, but populated even on a pass-through caused by the
   * `tried-enumeration-present` carve-out — the matches are still
   * surfaced for logging so investigations can see WHICH excuse
   * phrase the agent paired with the legitimate enumeration.
   */
  matches: LazyVerificationMatch[];
  /**
   * The system message to inject back into the turn when blocking.
   * Empty when `block === false`. Caller threads this into the SDK's
   * `systemMessage` output field.
   */
  reinjection: string;
  /** Diagnostic flag explaining why a match was passed through. */
  passReason?: 'no-match' | 'tried-enumeration-present';
}

/**
 * Catalogue of banned excuse phrases. Each pattern is anchored loosely
 * — case-insensitive, allows minor inflection — but stays narrow
 * enough to avoid swallowing benign mentions of the same words inside
 * unrelated discussion.
 *
 * Patterns mirror the bullet list in `no-lazy-verification.md`. Adding
 * a new evasion to the catalogue should require an observed production
 * incident, not speculation.
 */
const BANNED_PHRASES: { pattern: RegExp; label: string }[] = [
  {
    label: 'site-is-js-rendered',
    pattern: /\b(?:site|page) is (?:JS|JavaScript)[- ]rendered\b/i,
  },
  {
    label: 'page-is-thin',
    pattern: /\b(?:site|page) is (?:thin|almost empty|nearly empty|empty)\b/i,
  },
  {
    label: 'cant-access-this',
    pattern: /\b(?:can(?:'?|no)t|unable to) access (?:this|the (?:site|page|url))\b/i,
  },
  {
    label: 'cant-read-this-site',
    pattern: /\b(?:can(?:'?|no)t|unable to) read (?:this site|the (?:site|page))\b/i,
  },
  {
    label: 'couldnt-load-the-page',
    pattern: /\b(?:could(?:n'?|no)t|failed to|was unable to) load (?:the (?:page|site)|this (?:page|site)|it)\b/i,
  },
  {
    label: 'content-loads-dynamically',
    pattern: /\bcontent (?:is |gets )?(?:load(?:s|ed|ing)?|render(?:s|ed|ing)?) dynamically\b/i,
  },
];

/**
 * "Tried X — got Y" enumeration is the rule-sanctioned shape for
 * reporting genuine failure. We require at least two distinct `Tried`
 * statements (covering "tried tool A, tried tool B") because the rule
 * says enumerate what was tried — a single attempt isn't an
 * enumeration. The em dash, hyphen, and colon all count as separators
 * since the model varies its punctuation.
 */
const TRIED_STATEMENT_RE = /\bTried\b[^.\n]+(?:[—–\-:][^.\n]+)/gi;

/**
 * Inspect a message body and decide whether the lazy-verification
 * Stop hook should block.
 *
 * `lastAssistantMessage` is the SDK's `StopHookInput.last_assistant_message`
 * — the text content of the message the agent is about to ship. The
 * hook fires before the user sees it; on `block: true` the SDK runs
 * another turn with the injected system message in scope.
 */
export function detectLazyVerification(
  lastAssistantMessage: unknown,
): LazyVerificationDecision {
  if (typeof lastAssistantMessage !== 'string' || lastAssistantMessage.length === 0) {
    return { block: false, matches: [], reinjection: '', passReason: 'no-match' };
  }
  const matches: LazyVerificationMatch[] = [];
  for (const { pattern, label } of BANNED_PHRASES) {
    const m = pattern.exec(lastAssistantMessage);
    if (m) {
      matches.push({
        phrase: label,
        snippet: extractSnippet(lastAssistantMessage, m.index, m[0].length),
      });
    }
  }
  if (matches.length === 0) {
    return { block: false, matches, reinjection: '', passReason: 'no-match' };
  }
  // Genuine-failure carve-out: at least two `Tried ... — ...` statements
  // signal the agent actually attempted verification and is reporting
  // honest failure. The rule explicitly allows that shape.
  const triedHits = lastAssistantMessage.match(TRIED_STATEMENT_RE) ?? [];
  if (triedHits.length >= 2) {
    return {
      block: false,
      matches,
      reinjection: '',
      passReason: 'tried-enumeration-present',
    };
  }
  return {
    block: true,
    matches,
    reinjection: buildReinjection(matches),
  };
}

function extractSnippet(text: string, start: number, length: number): string {
  const window = 40;
  const left = Math.max(0, start - window);
  const right = Math.min(text.length, start + length + window);
  const lead = left > 0 ? '…' : '';
  const trail = right < text.length ? '…' : '';
  return lead + text.slice(left, right).replace(/\s+/g, ' ') + trail;
}

function buildReinjection(matches: LazyVerificationMatch[]): string {
  const phraseList = matches.map((m) => `\`${m.phrase}\``).join(', ');
  // The reinjection text is self-contained — it doesn't reference
  // the prose `no-lazy-verification.md` rule because that file is
  // scheduled for deletion once this hook lands (see PR description
  // tile-cleanup follow-up). The runtime is the source of truth;
  // the hook itself enforces the priority order embedded below.
  return (
    `Banned verification excuse(s) detected: ${phraseList}. ` +
    'Before reporting unverifiable, try at least one real verification ' +
    'tool in this priority order: ' +
    '(1) a JS-capable browser (Cloudflare Browser Rendering / Playwright), ' +
    '(2) a domain API (Composio / MCP), ' +
    '(3) WebFetch for static HTML, ' +
    '(4) code execution. ' +
    'If genuinely unverifiable, report the explicit "Tried X — got Y; ' +
    'tried A — got B" enumeration shape — that disables this gate.'
  );
}

/**
 * Exposed for the unit tests so the catalogue label set is stable.
 */
export const LAZY_VERIFICATION_PHRASE_LABELS = BANNED_PHRASES.map(
  (p) => p.label,
);
