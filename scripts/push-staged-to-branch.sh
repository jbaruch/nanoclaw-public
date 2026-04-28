#!/usr/bin/env bash
# Push staged fixups onto an existing tile-repo PR branch.
#
# Used after Copilot (or a human) leaves review comments on a promote PR:
# the agent edits the skill back in staging, then calls the
# `push_staged_to_branch` MCP tool, which runs this script. We clone the
# existing branch, copy staging over it, validate placement, commit, push.
# No new PR is opened.
#
# Rationale: Composio's GitHub toolkit can do single-file commits via
# GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS, but multi-file fixes (which skill
# reviews typically require) mean juggling the Git Data API by hand. The
# orchestrator already has GITHUB_TOKEN and a working `git` — letting it
# do the commit is shorter and avoids Composio's multi-file footgun.
#
# Usage:
#   push-staged-to-branch.sh <staging-dir> <tile-name> <branch> <commit-msg> [skill-name|all|--rules-only]
#
# Environment: GITHUB_TOKEN, TILE_OWNER (defaults to "jbaruch"), ASSISTANT_NAME.

set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./tile-repo-lib.sh
source "$SCRIPT_DIR/tile-repo-lib.sh"

# gh is required for the post-push Copilot re-summon. Fail fast here
# rather than after the commit+push has already landed — under
# `set -euo pipefail` a missing `gh` downstream would make the script
# exit non-zero AFTER the fixup has been pushed, which would make the
# MCP caller report failure even though the fixup is already live on
# the branch. Mirror the preflight in promote-to-tile-repo.sh.
if ! command -v gh >/dev/null; then
  echo "ERROR: push_staged_to_branch requires the GitHub CLI (gh) for the post-push Copilot re-summon." >&2
  echo "Install: https://cli.github.com/manual/installation" >&2
  echo "In the orchestrator container image, ensure gh is part of Dockerfile.orchestrator." >&2
  exit 1
fi

STAGING_DIR="${1:?staging directory required}"
TILE_NAME="${2:?tile name required}"
BRANCH="${3:?branch required}"
COMMIT_MSG="${4:?commit message required}"
MODE="${5:-all}"

TILE_OWNER="${TILE_OWNER:-jbaruch}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN required}"
ASSISTANT_NAME="${ASSISTANT_NAME:-Agent}"

SKILLS_SRC="$STAGING_DIR/skills"
RULES_SRC="$STAGING_DIR/rules"

TESSL_TILES_DIR="${TESSL_TILES_DIR:-}"

# --- Clone the existing branch ---
TILE_REPO_URL="https://x-access-token:${TOKEN}@github.com/${TILE_OWNER}/${TILE_NAME}.git"
TILE_REPO_DIR="/tmp/push-${TILE_NAME}-$$"

cleanup_temp() {
  rm -rf "$TILE_REPO_DIR"
}
trap cleanup_temp EXIT

echo "Cloning ${TILE_OWNER}/${TILE_NAME} @ ${BRANCH}..."
rm -rf "$TILE_REPO_DIR"
# --single-branch + --branch fails loudly if BRANCH doesn't exist on the
# remote — which is what we want (the caller is claiming it's an "existing
# PR branch"; if it's not, don't silently create one).
git clone --depth 1 --single-branch --branch "$BRANCH" "$TILE_REPO_URL" "$TILE_REPO_DIR"

PROMOTED=0
BLOCKED=0

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

    # Guard: canonical ends up interpolated into `$TILE_REPO_DIR/skills/
    # $canonical` and fed to `rm -rf` below, so any value that resolves
    # somewhere other than a sibling skill dir is a footgun:
    #   - `""`   → `.../skills/` (wipes every skill)
    #   - `.`    → `.../skills/.` (same)
    #   - `..`   → `.../skills/..` = `$TILE_REPO_DIR` (wipes the clone)
    #   - `a/b`  → escapes the skills/ subtree entirely
    #   - leading `-` → argv confusion with flags
    # Case-match restricts canonical to `[A-Za-z0-9][A-Za-z0-9_-]*` —
    # same character set tessl tile/skill names actually use.
    case "$canonical" in
      ''|'.'|'..'|*/*|*[!A-Za-z0-9_-]*|[!A-Za-z0-9]*)
        echo "ERROR: refusing to operate on unsafe canonical '$canonical' (from staging dir '$skill_dir'). Expected [A-Za-z0-9][A-Za-z0-9_-]*." >&2
        exit 2
        ;;
    esac

    # See matching comment in promote-to-tile-repo.sh — rc 1 is a policy
    # block, rc ≥ 2 is a read/grep error that must abort the whole push.
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

    # Cross-tile duplicate check: if the author somehow renamed a skill
    # into a slot already owned by another tile, block the push — same
    # rule as promote.
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

    # Wipe the destination before copying so file-level deletions in
    # staging (author removed a helper script between the initial
    # promote and this fixup) actually propagate into the branch. The
    # old mkdir+cp approach only overwrote — `git add -A` would see
    # no deletion because the file still existed in the clone, leaving
    # stale artifacts on the PR branch that the fixup flow couldn't
    # clean up. The canonical-name guard above makes the `rm -rf` safe.
    dst="$TILE_REPO_DIR/skills/$canonical"
    rm -rf "$dst"
    mkdir -p "$dst"
    cp -r "$src/." "$dst/"
    echo "pushed: $canonical"

    # Update tile.json (idempotent — same logic as promote). Values pass
    # through argv to avoid shell-interpolating skill names into the
    # Python source.
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
      echo "pushed rule: $name"

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

# --- Commit + push onto the existing branch ---
cd "$TILE_REPO_DIR"
git config user.email "nanoclaw@bot.local"
git config user.name "$ASSISTANT_NAME"
git add -A
if git diff --cached --quiet; then
  # Staging matches the branch tip. Treat this as a no-op success rather
  # than an error — a Copilot comment might legitimately call for a
  # change the author reverted, or the caller might retry after a
  # partial fix.
  echo "Branch $BRANCH already matches staging, nothing to push."
  echo "Done! 0 pushed, $BLOCKED blocked."
  exit 0
fi

git commit -m "$COMMIT_MSG"
# `--` before refspec so a branch name starting with `-` can't be
# reparsed as a git-push option.
git push origin -- "$BRANCH"

echo "Pushed $PROMOTED item(s) to $BRANCH on $TILE_OWNER/$TILE_NAME."

# Re-summon Copilot on the open PR for this branch. GitHub's automatic
# re-review on new commits is unreliable (observed flakiness on
# nanoclaw#75 during this PR's own bootstrap); explicit summon keeps
# the iteration-in-one-PR loop tight. If no PR exists for the branch
# (caller pushed to a branch that was never opened as a PR), skip
# with a hint — we don't want to silently no-op.
PR_NUMBER=$(GH_TOKEN="$TOKEN" gh pr list \
  --repo "$TILE_OWNER/$TILE_NAME" \
  --head "$BRANCH" \
  --state open \
  --json number \
  --jq '.[0].number // empty')
if [ -n "$PR_NUMBER" ]; then
  GH_TOKEN="$TOKEN" summon_copilot_or_warn "$TILE_OWNER" "$TILE_NAME" "$PR_NUMBER"
else
  echo "WARN: no open PR found for branch $BRANCH on $TILE_OWNER/$TILE_NAME — skipping Copilot re-summon."
  echo "      If this branch was created by promote_staging, the PR may have been closed or merged."
fi

echo "Done! $PROMOTED pushed, $BLOCKED blocked."
