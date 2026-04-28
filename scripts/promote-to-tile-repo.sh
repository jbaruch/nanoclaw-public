#!/usr/bin/env bash
# Promote staged skills/rules directly to a tile's GitHub repo.
# GHA handles skill review (85%), lint, and tessl publish.
#
# Usage:
#   promote-to-tile-repo.sh <staging-dir> <tile-name> [skill-name|all|--rules-only]
#
# Environment: GITHUB_TOKEN, TILE_OWNER (defaults to "jbaruch")
#
# Runs in both contexts:
#   - Inside orchestrator container (called by IPC handler)
#   - On host Mac (called by promote-from-host.sh wrapper)

set -euo pipefail

# Load nvm if available (NAS has tessl via nvm-managed npm)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

# gh is required for the PR-based promote flow. Fail fast with a
# clear install pointer rather than hitting a cryptic "gh: command
# not found" deep inside the script after we've already cloned the
# tile repo.
if ! command -v gh >/dev/null; then
  echo "ERROR: promote flow requires the GitHub CLI (gh)." >&2
  echo "Install: https://cli.github.com/manual/installation" >&2
  echo "In the orchestrator container image, add gh to Dockerfile.orchestrator." >&2
  exit 1
fi

STAGING_DIR="${1:?staging directory required}"
TILE_NAME="${2:?tile name required}"
MODE="${3:-all}"

TILE_OWNER="${TILE_OWNER:-jbaruch}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN required}"
ASSISTANT_NAME="${ASSISTANT_NAME:-Agent}"

SKILLS_SRC="$STAGING_DIR/skills"
RULES_SRC="$STAGING_DIR/rules"

# Cross-tile duplicate check: look at registry-installed tiles
TESSL_TILES_DIR="${TESSL_TILES_DIR:-}"

# Shared frontmatter + placement helpers. Kept in a separate file so the
# fixup-pushing script (push-staged-to-branch.sh) applies the same
# placement rules as a fresh promote — if they diverged, Copilot review
# comments could get re-pushed into the wrong tile.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./tile-repo-lib.sh
source "$SCRIPT_DIR/tile-repo-lib.sh"

# --- Clone tile repo ---
TILE_REPO_URL="https://x-access-token:${TOKEN}@github.com/${TILE_OWNER}/${TILE_NAME}.git"
TILE_REPO_DIR="/tmp/promote-${TILE_NAME}-$$"

# Clean up the temp clone on any exit path — success, failure, or
# partial-success mid-flow (e.g. PR created but Copilot summon
# failed). Without this, orphan /tmp/promote-*/ dirs pile up on the
# orchestrator. `-rf` is intentional: the dir is ours, single-purpose.
cleanup_temp() {
  rm -rf "$TILE_REPO_DIR"
}
trap cleanup_temp EXIT

echo "Cloning ${TILE_OWNER}/${TILE_NAME}..."
rm -rf "$TILE_REPO_DIR"
git clone --depth 1 "$TILE_REPO_URL" "$TILE_REPO_DIR"

PROMOTED=0
BLOCKED=0
PROMOTED_SKILLS=""

# --- Pull skills into clone ---
if [ "$MODE" != "--rules-only" ]; then
  if [ "$MODE" = "all" ]; then
    if [ -d "$SKILLS_SRC" ]; then
      SKILLS=$(ls "$SKILLS_SRC")
    else
      SKILLS=""
    fi
  else
    SKILLS="$MODE"
  fi

  for skill_dir in $SKILLS; do
    [ -z "$skill_dir" ] && continue
    src="$SKILLS_SRC/$skill_dir"
    [ -d "$src" ] || continue
    [ -f "$src/SKILL.md" ] || continue

    canonical="${skill_dir#tessl__}"

    # Guard (mirrors push-staged-to-branch.sh): restrict canonical to
    # `[A-Za-z0-9][A-Za-z0-9_-]*` — same character set tessl tile/skill
    # names actually use. Rejects empty (flat cp clobbers siblings),
    # `.`/`..` (escape out of skills/), `/` (arbitrary subpath), and
    # leading `-` (argv confusion with flags). The push script's `rm
    # -rf` makes this load-bearing; the promote script's `cp` has the
    # same footgun without a delete so we reject up front in both.
    case "$canonical" in
      ''|'.'|'..'|*/*|*[!A-Za-z0-9_-]*|[!A-Za-z0-9]*)
        echo "ERROR: refusing to operate on unsafe canonical '$canonical' (from staging dir '$skill_dir'). Expected [A-Za-z0-9][A-Za-z0-9_-]*." >&2
        exit 2
        ;;
    esac

    # Distinguish policy block (rc 1 → BLOCKED, continue) from hard failure
    # (rc ≥ 2 → grep read error, unreadable SKILL.md, etc. → abort). The
    # naive `if ! validate_placement ...` pattern collapses both into
    # "continue", which would silently skip a skill whose file we can't
    # read instead of failing the promote loudly.
    validate_rc=0
    validate_placement "$src/SKILL.md" "$TILE_NAME" "$canonical" || validate_rc=$?
    case $validate_rc in
      0) ;;
      1) BLOCKED=$((BLOCKED + 1)); continue ;;
      *)
        echo "ERROR: validate_placement returned rc=$validate_rc for $canonical — aborting" >&2
        exit "$validate_rc"
        ;;
    esac

    # Cross-tile duplicate check
    if [ -n "$TESSL_TILES_DIR" ]; then
      for other_tile_dir in "$TESSL_TILES_DIR"/nanoclaw-*/; do
        other_name=$(basename "$other_tile_dir")
        [ "$other_name" = "$TILE_NAME" ] && continue
        if [ -d "$other_tile_dir/skills/$canonical" ]; then
          echo "BLOCKED: $canonical already exists in $other_name"
          BLOCKED=$((BLOCKED + 1))
          continue 2
        fi
      done
    fi

    dst="$TILE_REPO_DIR/skills/$canonical"
    mkdir -p "$dst"
    cp -r "$src/." "$dst/"
    echo "pulled: $canonical"
    PROMOTED_SKILLS="$PROMOTED_SKILLS $canonical"

    # Update tile.json (add entry if new). Values pass through argv to
    # Python — never interpolate skill names into the script body (a
    # directory with a quote would break the snippet or enable injection).
    python3 - "$TILE_REPO_DIR/tile.json" "$canonical" <<'PY'
import json, sys
tile_path, canonical = sys.argv[1], sys.argv[2]
with open(tile_path) as f:
    tile = json.load(f)
skills = tile.setdefault('skills', {})
if canonical not in skills:
    skills[canonical] = {'path': f'skills/{canonical}/SKILL.md'}
    print(f'  added: {canonical}')
else:
    print(f'  exists: {canonical}')
with open(tile_path, 'w') as f:
    json.dump(tile, f, indent=2)
    f.write('\n')
PY
    PROMOTED=$((PROMOTED + 1))
  done
fi

# --- Pull rules into clone ---
if [ "$MODE" = "all" ] || [ "$MODE" = "--rules-only" ]; then
  if [ -d "$RULES_SRC" ]; then
    for rule_file in "$RULES_SRC"/*.md; do
      [ -f "$rule_file" ] || continue
      name=$(basename "$rule_file" .md)
      mkdir -p "$TILE_REPO_DIR/rules"
      cp "$rule_file" "$TILE_REPO_DIR/rules/$name.md"
      echo "pulled rule: $name"

      python3 - "$TILE_REPO_DIR/tile.json" "$name" <<'PY'
import json, sys
tile_path, name = sys.argv[1], sys.argv[2]
with open(tile_path) as f:
    tile = json.load(f)
rules = tile.setdefault('rules', {})
if name not in rules:
    rules[name] = {'rules': f'rules/{name}.md'}
    print(f'  added: {name}')
else:
    print(f'  exists: {name}')
with open(tile_path, 'w') as f:
    json.dump(tile, f, indent=2)
    f.write('\n')
PY
      PROMOTED=$((PROMOTED + 1))
    done
  fi
fi

if [ "$BLOCKED" -gt 0 ]; then
  echo ""
  echo "WARNING: $BLOCKED item(s) blocked by tile placement validation."
fi

if [ "$PROMOTED" -eq 0 ]; then
  echo "Nothing to promote."
  exit 0
fi

# --- Local skill review (read-only; never mutates content) ---
# Runs `tessl skill review` on each promoted skill before opening the
# PR. Reports the score so an obviously-broken skill surfaces locally
# instead of waiting for the post-merge GHA gate at threshold 85.
#
# `--optimize` is intentionally NOT used here. Observed 2026-04-27 on
# nanoclaw-admin#64 (closed): `--optimize --yes` rewrote check-cfps's
# SKILL.md from 212 → 126 lines, dropped its score 85% → 65%, and
# removed substantive content the agent author had deliberately kept.
# We are promoting the *agent's authored content*; rewriting it in
# transit defeats that contract. If a skill needs prose tightening,
# do it in source (NAS staging or container side) where the change is
# visible, reviewable, and survives the next promote.
#
# tessl may not be installed in every execution context. Fall back
# with a warning instead of blocking — Copilot on the PR + GHA at
# merge time are the actual gates.
if command -v tessl >/dev/null 2>&1; then
  for skill_name in $PROMOTED_SKILLS; do
    echo "reviewing: $skill_name"
    tessl skill review "$TILE_REPO_DIR/skills/$skill_name"
  done
else
  echo "WARN: tessl not found, skipping local skill review (Copilot + GHA will review)"
fi

# --- Commit, push branch, open PR, request Copilot review ---
cd "$TILE_REPO_DIR"
git config user.email "nanoclaw@bot.local"
git config user.name "$ASSISTANT_NAME"
git add -A
if git diff --cached --quiet; then
  echo "Tile repo already up to date."
  echo "Done! $PROMOTED promoted, $BLOCKED blocked."
  exit 0
fi

# Branch named with UTC timestamp + tile + 4-hex-char random suffix so
# two promotes targeting the same tile within the same second can't
# collide at `git checkout -b` / `git push`. Short enough to scan in
# the GitHub UI.
BRANCH="promote/$(date -u +%Y%m%dT%H%M%SZ)-${TILE_NAME}-$(printf '%04x' $((RANDOM * RANDOM & 0xffff)))"
git checkout -b "$BRANCH"
COMMIT_MSG="feat: promote $PROMOTED item(s) from $ASSISTANT_NAME staging"
git commit -m "$COMMIT_MSG"

# Push branch. `--` before the refspec guards against a pathological
# branch name starting with `-` getting reparsed as a git-push option.
# Not currently possible because BRANCH is constructed above, but future
# refactors should inherit the safety without thinking.
git push -u origin -- "$BRANCH"

# Print the branch name on its own line so the agent can parse it out of
# stdout and feed it back to the `push_staged_to_branch` MCP tool for
# fixup commits.
echo "Branch: $BRANCH"

PR_BODY="Promoted by nanoclaw's promote-to-tile-repo.sh. $PROMOTED item(s) staged by $ASSISTANT_NAME.

## Review gate
Copilot review requested below. Merge after the review is clean and any findings are addressed. GHA (tessl publish, lint) runs at merge time on main.

## Iteration
Fixups land on THIS branch via the \`push_staged_to_branch\` MCP tool: read PR comments → fix in staging → call the tool with branch \`$BRANCH\`. Restage-and-re-promote is the fallback; it opens a new PR."

# --repo pinned explicitly per repo-chain.md: gh otherwise defaults to
# the upstream fork in some environments and would leak tile updates
# to the wrong repo.
GH_TOKEN="$TOKEN" gh pr create \
  --repo "$TILE_OWNER/$TILE_NAME" \
  --base main \
  --head "$BRANCH" \
  --title "$COMMIT_MSG" \
  --body "$PR_BODY" \
  >/dev/null

# Look up URL + number via structured JSON rather than parsing `gh pr
# create`'s stdout. The create command prints a bare URL today, but if
# its human-output format ever drifts (extra status lines, color codes,
# whatever) the previous `${PR_URL##*/}` parse would quietly break and
# we'd silently skip the Copilot summon. Querying by head ref via gh's
# own --jq is stable and needs no external parser (no jq binary in the
# orchestrator image).
#
# Retry for GitHub's eventual consistency between `gh pr create`
# completing and `gh pr list --head` reflecting it — usually instant,
# but we've observed ~5s lags. jq's `// ""` turns an empty array into
# an empty string, so the `-z` check is a single condition.
PR_URL=""
for _ in 1 2 3 4 5; do
  PR_URL=$(GH_TOKEN="$TOKEN" gh pr list \
    --repo "$TILE_OWNER/$TILE_NAME" \
    --head "$BRANCH" \
    --state open \
    --json url \
    --jq '.[0].url // ""')
  [ -n "$PR_URL" ] && break
  sleep 2
done
if [ -z "$PR_URL" ]; then
  echo "ERROR: branch $BRANCH was pushed but no matching open PR is visible on $TILE_OWNER/$TILE_NAME after 5 retries." >&2
  echo "Check https://github.com/$TILE_OWNER/$TILE_NAME/pulls and open/summon manually." >&2
  exit 1
fi
PR_NUMBER=$(GH_TOKEN="$TOKEN" gh pr list \
  --repo "$TILE_OWNER/$TILE_NAME" \
  --head "$BRANCH" \
  --state open \
  --json number \
  --jq '.[0].number // ""')
if [ -z "$PR_NUMBER" ]; then
  echo "ERROR: PR URL $PR_URL found but PR number lookup returned empty — giving up on Copilot summon." >&2
  exit 1
fi

echo "PR opened: $PR_URL"

# Summon Copilot. `summon_copilot_or_warn` lives in tile-repo-lib.sh so
# the fixup-push script can call the same code — consistency here matters
# because every branch update should get the same reviewer treatment.
GH_TOKEN="$TOKEN" summon_copilot_or_warn "$TILE_OWNER" "$TILE_NAME" "$PR_NUMBER"

echo "Done! $PROMOTED promoted, $BLOCKED blocked."
