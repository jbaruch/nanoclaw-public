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

# --- Tile placement validation ---
validate_placement() {
  local skill_file="$1"
  local tile="$2"
  local canonical="$3"

  if [ "$tile" = "nanoclaw-admin" ]; then return 0; fi

  if [ "$tile" = "nanoclaw-untrusted" ]; then
    if grep -qiE 'composio|gmail|calendar|tasks|schedule_task|promote|host_script' "$skill_file" 2>/dev/null; then
      echo "BLOCKED: $canonical has admin-level content but target is $tile"
      return 1
    fi
    return 0
  fi

  if grep -qiE 'composio|gmail|googlecalendar|googletasks|promote_staging|github_backup|register_group' "$skill_file" 2>/dev/null; then
    echo "BLOCKED: $canonical has admin-level content but target is $tile"
    return 1
  fi

  if [ "$tile" = "nanoclaw-core" ]; then
    if grep -qiE '/workspace/trusted/|trusted.memory|cross.group' "$skill_file" 2>/dev/null; then
      echo "BLOCKED: $canonical references trusted workspace but target is core"
      return 1
    fi
  fi

  return 0
}

# --- Clone tile repo ---
TILE_REPO_URL="https://x-access-token:${TOKEN}@github.com/${TILE_OWNER}/${TILE_NAME}.git"
TILE_REPO_DIR="/tmp/promote-${TILE_NAME}-$$"

echo "Cloning ${TILE_OWNER}/${TILE_NAME}..."
rm -rf "$TILE_REPO_DIR"
git clone --depth 1 "$TILE_REPO_URL" "$TILE_REPO_DIR"

PROMOTED=0
BLOCKED=0
PROMOTED_SKILLS=""

# --- Pull skills into clone ---
if [ "$MODE" != "--rules-only" ]; then
  if [ "$MODE" = "all" ]; then
    SKILLS=$(ls "$SKILLS_SRC" 2>/dev/null || true)
  else
    SKILLS="$MODE"
  fi

  for skill_dir in $SKILLS; do
    [ -z "$skill_dir" ] && continue
    src="$SKILLS_SRC/$skill_dir"
    [ -d "$src" ] || continue
    [ -f "$src/SKILL.md" ] || continue

    canonical="${skill_dir#tessl__}"

    if ! validate_placement "$src/SKILL.md" "$TILE_NAME" "$canonical"; then
      BLOCKED=$((BLOCKED + 1))
      continue
    fi

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

    # Update tile.json (add entry if new)
    python3 -c "
import json, sys
with open('$TILE_REPO_DIR/tile.json') as f:
    tile = json.load(f)
skills = tile.setdefault('skills', {})
if '$canonical' not in skills:
    skills['$canonical'] = {'path': 'skills/$canonical/SKILL.md'}
    print('  added: $canonical')
else:
    print('  exists: $canonical')
with open('$TILE_REPO_DIR/tile.json', 'w') as f:
    json.dump(tile, f, indent=2)
    f.write('\n')
"
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

      python3 -c "
import json
with open('$TILE_REPO_DIR/tile.json') as f:
    tile = json.load(f)
rules = tile.setdefault('rules', {})
if '$name' not in rules:
    rules['$name'] = {'rules': 'rules/$name.md'}
    print('  added: $name')
else:
    print('  exists: $name')
with open('$TILE_REPO_DIR/tile.json', 'w') as f:
    json.dump(tile, f, indent=2)
    f.write('\n')
"
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
  rm -rf "$TILE_REPO_DIR"
  exit 0
fi

# --- Skill review + optimize (shift-left: fix before CI) ---
if [ -n "$PROMOTED_SKILLS" ] && command -v tessl >/dev/null 2>&1; then
  for skill_name in $PROMOTED_SKILLS; do
    echo "reviewing: $skill_name"
    tessl skill review --optimize --yes "$TILE_REPO_DIR/skills/$skill_name"
  done
elif [ -n "$PROMOTED_SKILLS" ]; then
  echo "WARN: tessl not found, skipping local skill review"
fi

# --- Commit and push ---
cd "$TILE_REPO_DIR"
git config user.email "nanoclaw@bot.local"
git config user.name "$ASSISTANT_NAME"
git add -A
if git diff --cached --quiet; then
  echo "Tile repo already up to date."
else
  git commit -m "feat: promote $PROMOTED item(s) from $ASSISTANT_NAME staging"
  git push origin main
  echo "Pushed to ${TILE_OWNER}/${TILE_NAME} — GHA will review, lint, and publish."
fi

rm -rf "$TILE_REPO_DIR"
echo "Done! $PROMOTED promoted, $BLOCKED blocked."
