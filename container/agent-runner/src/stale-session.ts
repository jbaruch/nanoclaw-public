/**
 * Stale-session detector for the agent-runner's throw-retry path.
 *
 * MUST stay in sync with `src/index.ts:STALE_SESSION_RE` in the
 * orchestrator package. The orchestrator and the agent-runner are
 * separate npm packages with separate tsconfigs, so they cannot share
 * a module — the regex is duplicated here on purpose. Both packages
 * have a unit-test suite that asserts on the same canonical input
 * strings (`stale-session.test.ts` in each); a drift between the two
 * patterns shows up as a test failure on at least one side.
 *
 * Match set rationale: the agent-runner's throw-retry path catches
 * thrown exceptions out of the SDK's `runQuery`. The historical narrow
 * regex (`/session|conversation not found|resume/i`) missed the same
 * SDK error shapes the orchestrator's pre-#144 regex did — most
 * importantly `error_during_execution` and the JSONL-ENOENT shape.
 * Without those tokens, a thrown stale-session error here would NOT
 * trigger the throw-side fresh-session retry, and the run would bubble
 * up as a generic error instead of the recovery the path is meant to
 * enact.
 *
 * Per `jbaruch/nanoclaw#155`, the regex is centralised in this single
 * helper inside the package; the throw-retry call site in `index.ts`
 * imports it rather than embedding its own check.
 */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|error_during_execution/i;

export function isStaleSessionError(errorMsg: string | undefined): boolean {
  if (!errorMsg) return false;
  return STALE_SESSION_RE.test(errorMsg);
}
