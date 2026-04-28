#!/usr/bin/env bash
# Shared helpers for the tile-repo flow:
#   - scripts/promote-to-tile-repo.sh (opens a new PR)
#   - scripts/push-staged-to-branch.sh (appends fixups to an existing PR branch)
#
# Source-only — not meant to be run directly. Callers must have `set -e`
# active so the awk/grep invariants actually fail the script.

# Read a single frontmatter field from a SKILL.md. Prints the normalised
# value on stdout (empty if unset or no frontmatter block). Frontmatter
# is the block between the first two `---` markers at the top of the file.
#
# Robust against common YAML-ish variants:
# - `field: true`        (space after colon)
# - `field:true`         (no space after colon)
# - `field: true  `      (trailing whitespace)
# - `field: true # note` (inline comment stripped)
# - `field: "true"` / `field: 'true'` (surrounding quotes stripped)
#
# Silent-fail would be dangerous here — an author who writes
# `placement-admin-content-ok:true` thinking the bypass flag is set, then
# watches their skill get blocked anyway, has no way to diagnose the
# mismatch. Normalise defensively.
read_frontmatter_field() {
  local file="$1"
  local field="$2"
  # Match is buffered and only emitted if we saw both opening AND closing
  # `---` markers. Without the closing check, a malformed SKILL.md that
  # opens with `---` but never closes it would let body-level `field:`
  # occurrences be parsed as frontmatter — which would let an attacker
  # smuggle `placement-admin-content-ok: true` into the body and bypass
  # validation.
  awk -v f="$field" '
    NR == 1 && $0 != "---" { exit }
    NR == 1 { in_fm = 1; next }
    in_fm && $0 == "---" { closed = 1; exit }
    in_fm && !found {
      prefix_re = "^[[:space:]]*" f "[[:space:]]*:"
      if ($0 !~ prefix_re) next
      line = $0
      sub(prefix_re, "", line)
      sub("^[[:space:]]+", "", line)   # strip leading ws after colon
      # Value begins with `#` after trimming — the entire line after the
      # colon is a comment, so the field has no value.
      if (substr(line, 1, 1) == "#") { matched = ""; found = 1; next }
      # Quoted values must be parsed BEFORE stripping `#` comments, because
      # in YAML `#` inside quotes is literal, not a comment.
      if (length(line) >= 2) {
        first = substr(line, 1, 1)
        if (first == "\"" || first == "\047") {
          # Find the rightmost matching quote (naive — does not handle
          # escaped quotes, but frontmatter boolean flags never need that).
          rest = substr(line, 2)
          for (i = length(rest); i >= 1; i--) {
            if (substr(rest, i, 1) == first) {
              matched = substr(rest, 1, i - 1)
              found = 1
              next
            }
          }
          # No closing quote — fall through to unquoted handling.
        }
      }
      # Unquoted value: strip `#` comments (must be preceded by whitespace,
      # per YAML), then strip trailing whitespace.
      sub("[[:space:]]+#.*$", "", line)
      sub("[[:space:]]+$", "", line)
      matched = line
      found = 1
    }
    END {
      if (closed && found) print matched
    }
  ' "$file"
}

# Tile placement validation. Exit codes:
#   0  → placement is legal, caller should proceed
#   1  → policy block (BLOCKED: line on stdout), caller should skip+log
#   ≥2 → hard failure propagated from `grep_check` (read error on the
#        skill file, or any future internal invariant break). Caller
#        MUST NOT treat this like rc 1; the promote/push loops case-
#        match explicitly and `exit` on rc ≥2 rather than `continue`,
#        so an unreadable SKILL.md aborts the run loudly instead of
#        quietly being skipped.
#
# Callers must pre-verify `$skill_file` exists — we don't re-check.
#
# `grep_check <pattern> <file>` is a private helper that distinguishes grep's
# three exit codes:
#   rc 0 (match)       → prints "match"    on stdout, returns 0
#   rc 1 (no match)    → prints "nomatch"  on stdout, returns 0
#   rc 2+ (read error) → prints a diagnostic on STDERR, returns 2
#
# `grep_check` does NOT exit the script on rc 2 — it only returns 2 up
# the stack. `set -e` alone would NOT convert this into a script-abort
# because errexit is suppressed when a command runs inside an `if` /
# `&&` / `||` conditional. Callers (both direct and via
# `validate_placement`) MUST case-match on the rc and exit/return
# explicitly; see the promote/push loops in `promote-to-tile-repo.sh`
# and `push-staged-to-branch.sh` for the expected pattern
# (`rc 0 → legal, 1 → policy block, else → exit rc`). A caller that
# does `if ! grep_check ...; then` lumps rc 1 and rc 2 together and
# silently lets unreadable files through — don't do that.
grep_check() {
  local pattern="$1"
  local file="$2"
  local rc=0
  grep -qiE "$pattern" "$file" || rc=$?
  case $rc in
    0) echo match ;;
    1) echo nomatch ;;
    *)
      echo "ERROR: grep failed to read $file (rc=$rc)" >&2
      return 2
      ;;
  esac
}

validate_placement() {
  local skill_file="$1"
  local tile="$2"
  local canonical="$3"

  if [ "$tile" = "nanoclaw-admin" ]; then return 0; fi

  # Explicit opt-in bypass for skills that legitimately document admin-level
  # names as reference content (e.g. scrub-list entries in `ship-code`).
  # Scope: this flag ONLY skips the admin-content regex checks — tile-
  # specific structural rules (like nanoclaw-core's trusted-workspace
  # reference block) still apply. The admin-content regex can't distinguish
  # "uses these handlers" from "warns you to scrub these handlers"; the
  # flag is the author's assertion that the mentions are intentional
  # reference material. Auditable — `grep -r 'placement-admin-content-ok: true' tiles/`
  # lists every skill that opts out.
  local skip_admin_regex=false
  if [ "$(read_frontmatter_field "$skill_file" 'placement-admin-content-ok')" = "true" ]; then
    echo "  placement check: admin-content regex bypassed by frontmatter flag for $canonical"
    skip_admin_regex=true
  fi

  local admin_pattern
  if [ "$tile" = "nanoclaw-untrusted" ]; then
    admin_pattern='composio|gmail|calendar|tasks|schedule_task|promote|host_script|sync_tripit|fetch_trakt'
  else
    admin_pattern='composio|gmail|googlecalendar|googletasks|sessionize|sync_tripit|fetch_trakt|promote_staging|github_backup|register_group'
  fi

  if ! $skip_admin_regex; then
    local admin_rc
    admin_rc=$(grep_check "$admin_pattern" "$skill_file") || return 2
    if [ "$admin_rc" = "match" ]; then
      echo "BLOCKED: $canonical has admin-level content but target is $tile"
      return 1
    fi
  fi

  if [ "$tile" = "nanoclaw-untrusted" ]; then
    return 0
  fi

  # nanoclaw-core's trusted-workspace check runs regardless of the
  # admin-content bypass — these are orthogonal concerns.
  if [ "$tile" = "nanoclaw-core" ]; then
    local trusted_rc
    trusted_rc=$(grep_check '/workspace/trusted/|trusted.memory|cross.group' "$skill_file") || return 2
    if [ "$trusted_rc" = "match" ]; then
      echo "BLOCKED: $canonical references trusted workspace but target is core"
      return 1
    fi
  fi

  return 0
}

# Summon the Copilot pull-request reviewer on <owner>/<repo> PR #<number>.
# Best-effort: on API flake / missing token scope we log a manual-summon
# hint and return non-zero, but never abort the caller — by the time we
# get here, the branch is already pushed and the PR already open/updated,
# and failing the whole script over a summon flake would leave the
# operator uncertain whether the work landed.
#
# REST /requested_reviewers silently drops bot reviewers (HTTP 201, empty
# requested_reviewers array). Only the GraphQL `requestReviews` mutation
# with `botIds` sticks. BOT_kgDOCnlnWA is copilot-pull-request-reviewer;
# the bot node ID is stable across repos.
#
# Callers must export GH_TOKEN (or GITHUB_TOKEN — `gh` accepts either)
# with `pull_requests: write` on the target repo. Without that, both the
# lookup and the mutation fail with "Resource not accessible by personal
# access token" and we log the usual manual-summon hint.
summon_copilot() {
  local owner="$1"
  local repo="$2"
  local pr_number="$3"
  local pr_node_id
  pr_node_id=$(gh api graphql -f query='
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { id }
    }
  }' -f owner="$owner" -f name="$repo" -F number="$pr_number" --jq .data.repository.pullRequest.id) \
    || return 1
  # `gh api ... --jq` prints the literal string "null" (not empty) when
  # the field is missing — happens if the PR lookup succeeded but
  # returned no data (e.g. a race where the PR was deleted between
  # create and lookup). Treat "null" as failure, not as a valid node
  # ID; passing it to the mutation would error out with a confusing
  # "ID_INVALID" instead of our clear "could not summon" warning.
  if [ -z "$pr_node_id" ] || [ "$pr_node_id" = "null" ]; then
    return 1
  fi
  gh api graphql -f query='
  mutation($prId: ID!, $botIds: [ID!]!) {
    requestReviews(input: { pullRequestId: $prId, botIds: $botIds, union: true }) {
      pullRequest { number }
    }
  }' -F prId="$pr_node_id" -F 'botIds[]=BOT_kgDOCnlnWA' >/dev/null
}

# Convenience wrapper: call summon_copilot and log a result line either
# way so operators can tell at a glance whether the summon stuck.
# Arguments: <owner> <repo> <pr_number>
summon_copilot_or_warn() {
  local owner="$1"
  local repo="$2"
  local pr_number="$3"
  if summon_copilot "$owner" "$repo" "$pr_number"; then
    echo "Copilot review requested on $owner/$repo#$pr_number"
  else
    echo "WARN: could not summon Copilot on $owner/$repo#$pr_number — the PR is up; summon manually via:"
    echo "  gh api graphql -f query='mutation { requestReviews(input: { pullRequestId: <node_id>, botIds: [\"BOT_kgDOCnlnWA\"], union: true }) { pullRequest { number } } }'"
  fi
}
