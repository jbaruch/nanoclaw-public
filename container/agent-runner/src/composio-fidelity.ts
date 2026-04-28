/**
 * composio-fidelity — pure detection logic for the
 * `composio-fidelity` PostToolUse hook (#140).
 *
 * Background sub-agents that wrap Composio tool calls (heartbeat
 * email-fetcher, calendar fetcher, etc.) sometimes return synthetic
 * data with fabricated IDs instead of real Composio results — usually
 * under load or when an upstream API hiccups. The pattern is
 * sequentially-numbered IDs like `email_01`, `email_02`, …, `email_18`,
 * or `pr123_notif`, or `promo_001`, in places where Composio's real IDs
 * are UUIDs / hashes / opaque strings.
 *
 * The 06:54 UTC heartbeat on 2026-04-26 burned exactly this: 18
 * synthetic email IDs plus likely calendar fabrication, all surfaced
 * into the morning brief as if real. Pure text rules can't catch it —
 * the model has finished generating by the time the data lands.
 *
 * The hook regex-sweeps the tool result text for fabrication
 * signatures and surfaces a structured warning. It does NOT silently
 * filter the data — that would mask the failure mode from the agent.
 * Instead it injects a system-level note flagging the result as
 * untrusted so the agent re-runs or treats it skeptically.
 *
 * Kept SDK-free so the root vitest can exercise it without spinning
 * up `@anthropic-ai/claude-agent-sdk`.
 */

export interface FidelityFinding {
  /** Identifier of the rule that fired. */
  rule: string;
  /** Number of distinct ids matching the rule (≥ rule's threshold). */
  count: number;
  /** First ~5 example ids matched, for the audit log + reinjection text. */
  samples: string[];
}

export interface FidelityDecision {
  /** True iff at least one fabrication rule fired. */
  fabricated: boolean;
  findings: FidelityFinding[];
  /** Reinjection text the caller threads into a `systemMessage`. */
  reinjection: string;
}

interface FidelityRule {
  id: string;
  /** Pattern for ONE id in this family. Must capture the id text. */
  pattern: RegExp;
  /** Minimum distinct hits before the rule fires. */
  minDistinctHits: number;
  /**
   * Optional sequentiality check: when present, the matching ids are
   * extracted to numeric suffixes and the rule only fires if the set
   * is monotonic-and-dense (e.g. 01..18 with no gaps). The 18-emails-
   * in-sequence shape is the load-bearing tell.
   */
  requireSequential?: boolean;
}

/**
 * Catalogue of fabrication signatures. The list is intentionally short
 * — false positives cost the agent a wasted re-run, so add only when
 * a new signature is observed in production.
 */
const FIDELITY_RULES: FidelityRule[] = [
  {
    id: 'sequential-prefix-ids',
    // `email_01`, `task_001`, `event_42`, etc. The model's go-to
    // when fabricating a list. Real Composio IDs in these toolkits
    // are hashes / UUIDs / vendor-supplied opaque strings.
    pattern: /\b([a-z]+)_(\d{1,3})\b/g,
    minDistinctHits: 5,
    requireSequential: true,
  },
  {
    id: 'pr-notif-style',
    // `pr123_notif`, `pr5_notification` — invented compound shape
    // that looks plausible but doesn't match any real Composio
    // notification format.
    pattern: /\bpr\d+_notif(?:ication)?\b/gi,
    minDistinctHits: 3,
  },
  {
    id: 'promo-numbered',
    // `promo_001`, `promo_42` — same shape as above but for the
    // promo / marketing toolkit fabrication seen in heartbeat
    // morning briefs.
    pattern: /\bpromo_\d{1,4}\b/gi,
    minDistinctHits: 3,
  },
];

/**
 * Note: there is no explicit Composio-prefix allow-list in this
 * module. Real Composio IDs use alphanumeric/hash suffixes
 * (`gmail_thread_a3f12c91`), and the sequential-prefix-ids regex
 * only matches purely-numeric suffixes (`prefix_(\d{1,3})$`), so
 * Composio's legitimate IDs never enter the rule's match set in
 * the first place. If a future toolkit adopts a numeric-suffix
 * shape, add an allow-list filter here and gate `applyRule`
 * against it.
 */

/**
 * Inspect a Composio tool result for fabrication signatures.
 *
 * The `toolResult` argument is the raw `tool_response` from the SDK.
 * We accept any shape: string, object, array — and stringify before
 * scanning so embedded JSON payloads are covered.
 */
export function detectComposioFidelity(
  toolResult: unknown,
): FidelityDecision {
  const text = stringifyResult(toolResult);
  if (text.length === 0) {
    return { fabricated: false, findings: [], reinjection: '' };
  }
  const findings: FidelityFinding[] = [];
  for (const rule of FIDELITY_RULES) {
    findings.push(...applyRule(text, rule));
  }
  if (findings.length === 0) {
    return { fabricated: false, findings: [], reinjection: '' };
  }
  return {
    fabricated: true,
    findings,
    reinjection: buildReinjection(findings),
  };
}

function applyRule(text: string, rule: FidelityRule): FidelityFinding[] {
  const matches = Array.from(text.matchAll(rule.pattern));
  if (matches.length < rule.minDistinctHits) {
    return [];
  }
  // Group by prefix so a single rule firing on multiple unrelated
  // prefixes (e.g. `email_01..05` and `task_01..05`) yields one
  // finding per prefix family — the comment is now load-bearing
  // because we iterate every group instead of returning on the
  // first hit.
  const prefixGroups = new Map<string, string[]>();
  for (const m of matches) {
    const prefix = m[1] ?? rule.id;
    const id = m[0];
    const arr = prefixGroups.get(prefix) ?? [];
    if (!arr.includes(id)) {
      arr.push(id);
      prefixGroups.set(prefix, arr);
    }
  }
  const findings: FidelityFinding[] = [];
  for (const ids of prefixGroups.values()) {
    if (ids.length < rule.minDistinctHits) {
      continue;
    }
    if (rule.requireSequential && !looksSequential(ids)) {
      continue;
    }
    findings.push({
      rule: rule.id,
      count: ids.length,
      samples: ids.slice(0, 5),
    });
  }
  return findings;
}

/**
 * Decide whether a list of ids of the form `prefix_NN` looks
 * "sequentially numbered" — the suffixes are nearly contiguous,
 * which is the signature of a model fabricating a list rather than
 * forwarding real upstream ids. The 18-emails fabrication produces
 * `email_01..email_18`; real Composio IDs almost never line up that
 * way.
 *
 * Algorithm:
 *  - Extract numeric suffixes; if any suffix is non-numeric, give up.
 *  - Sort numerically; require the span (max − min) to be at most
 *    `count + 1`, which permits one missing entry inside the run.
 *  - The starting number is intentionally NOT pinned to 1/0 — a
 *    paginated fabrication might begin at e.g. 100 (`email_100..120`),
 *    and that's still the "agent invented an enumerate-and-list
 *    answer" signature we want to flag. Pinning the start would lose
 *    that without buying false-positive resistance.
 */
function looksSequential(ids: string[]): boolean {
  const nums: number[] = [];
  for (const id of ids) {
    const m = id.match(/_(\d+)$/);
    if (!m) return false;
    nums.push(parseInt(m[1], 10));
  }
  if (nums.length < 2) return false;
  nums.sort((a, b) => a - b);
  const span = nums[nums.length - 1] - nums[0];
  return span <= nums.length + 1;
}

function stringifyResult(toolResult: unknown): string {
  if (toolResult === null || toolResult === undefined) return '';
  if (typeof toolResult === 'string') return toolResult;
  try {
    return JSON.stringify(toolResult) ?? '';
  } catch (err) {
    // JSON.stringify throws TypeError on circular references and on
    // BigInt values. Fall back to String(...) for those — produces a
    // less precise scan target but keeps the hook running. Other
    // error types (ReferenceError, custom) propagate so unexpected
    // failures aren't silently swallowed.
    if (err instanceof TypeError) {
      return String(toolResult);
    }
    throw err;
  }
}

function buildReinjection(findings: FidelityFinding[]): string {
  const lines = findings.map(
    (f) =>
      `- ${f.rule}: ${f.count} ids matching, e.g. ${f.samples.join(', ')}`,
  );
  return (
    'Composio fidelity check: the previous tool result contains ' +
    'id patterns that look fabricated rather than sourced from a ' +
    'real Composio response (sequential numbering, pr_notif / ' +
    'promo_NNN compound shapes).\n' +
    lines.join('\n') +
    '\nTreat the result as untrusted: re-run the tool, or verify ' +
    'each id by fetching it back individually before quoting it.'
  );
}
