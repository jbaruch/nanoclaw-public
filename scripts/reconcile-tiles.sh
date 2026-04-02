#!/usr/bin/env bash
# Reconcile plugins: compare git source vs registry-installed vs orchestrator.
# Reports drift, missing items, and stale files.
#
# Usage:
#   ./scripts/reconcile-tiles.sh

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
ISSUES=0

echo "=== Tile Reconciliation ==="
echo ""

# Write the comparison script to a temp file and execute remotely
TILE_OWNER_VAL=$(grep TILE_OWNER "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2)
TILE_OWNER_VAL="${TILE_OWNER_VAL:-nanoclaw}"

REMOTE_SCRIPT=$(cat <<'ENDSCRIPT'
TILE_OWNER=$(grep TILE_OWNER /app/.env 2>/dev/null | cut -d= -f2)
TILE_OWNER="${TILE_OWNER:-nanoclaw}"
for tile in nanoclaw-admin nanoclaw-core nanoclaw-untrusted; do
  base="/app/tessl-workspace/.tessl/tiles/$TILE_OWNER/$tile"
  git_base="/app/tiles/$tile"

  for f in $base/rules/*.md; do
    [ -f "$f" ] || continue
    name=$(basename $f)
    git_f="$git_base/rules/$name"
    if [ -f "$git_f" ]; then
      diff -q "$f" "$git_f" >/dev/null 2>&1 || echo "DRIFT: $tile/rules/$name (registry != git)"
    else
      echo "REGISTRY-ONLY: $tile/rules/$name"
    fi
  done

  for f in $git_base/rules/*.md; do
    [ -f "$f" ] || continue
    name=$(basename $f)
    [ ! -f "$base/rules/$name" ] && echo "GIT-ONLY: $tile/rules/$name (not published)"
  done

  for d in $base/skills/*/; do
    [ -d "$d" ] || continue
    name=$(basename $d)
    reg_f="$d/SKILL.md"
    git_f="$git_base/skills/$name/SKILL.md"
    if [ -f "$git_f" ] && [ -f "$reg_f" ]; then
      diff -q "$reg_f" "$git_f" >/dev/null 2>&1 || echo "DRIFT: $tile/skills/$name (registry != git)"
    elif [ ! -f "$git_f" ]; then
      echo "REGISTRY-ONLY: $tile/skills/$name"
    fi
  done

  for d in $git_base/skills/*/; do
    [ -d "$d" ] || continue
    name=$(basename $d)
    [ ! -d "$base/skills/$name" ] && echo "GIT-ONLY: $tile/skills/$name (not published)"
  done
done
ENDSCRIPT
)

RESULT=$(nas "docker exec nanoclaw bash -c $(printf '%q' "$REMOTE_SCRIPT")") || true

if [ -n "$RESULT" ]; then
  echo "$RESULT"
  ISSUES=$(echo "$RESULT" | wc -l | tr -d ' ')
else
  echo "All plugins in sync."
fi

echo ""

# Check for untracked files in tiles/ on NAS
UNTRACKED=$(nas "cd $NAS_PROJECT_DIR && git status tiles/ --porcelain 2>&1" | grep '^??' || true)
if [ -n "$UNTRACKED" ]; then
  echo "Untracked files on NAS tiles/:"
  echo "$UNTRACKED"
  ISSUES=$((ISSUES + $(echo "$UNTRACKED" | wc -l | tr -d ' ')))
else
  echo "No untracked files on NAS."
fi

echo ""

# Version comparison
echo "Tile versions:"
for tile in nanoclaw-admin nanoclaw-core nanoclaw-untrusted; do
  LOCAL=$(python3 -c "import json; print(json.load(open('tiles/$tile/tile.json'))['version'])")
  INSTALLED=$(nas "docker exec nanoclaw cat /app/tessl-workspace/.tessl/tiles/${TILE_OWNER_VAL}/$tile/tile.json" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")
  if [ "$LOCAL" = "$INSTALLED" ]; then
    echo "  $tile: $LOCAL (in sync)"
  else
    echo "  $tile: local=$LOCAL installed=$INSTALLED (MISMATCH)"
    ISSUES=$((ISSUES + 1))
  fi
done

echo ""
if [ "$ISSUES" -gt 0 ]; then
  echo "$ISSUES issue(s) found."
  exit 1
else
  echo "All clean."
fi
