#!/usr/bin/env bash
# Promote staged skills/rules from NAS to tile GitHub repos.
# Thin wrapper: pulls staging from NAS, calls promote-to-tile-repo.sh.
#
# Usage:
#   ./scripts/promote-from-host.sh                         # promote ALL for default tile
#   TILE_NAME=nanoclaw-trusted ./scripts/promote-from-host.sh
#   TILE_NAME=nanoclaw-admin ./scripts/promote-from-host.sh heartbeat

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
GROUP_FOLDER="${GROUP_FOLDER:-telegram_swarm}"
TILE_NAME="${TILE_NAME:-nanoclaw-admin}"
MODE="${1:-all}"

STAGING_BASE="$NAS_PROJECT_DIR/groups/$GROUP_FOLDER/staging/$TILE_NAME"
LOCAL_STAGING="/tmp/promote-staging-${TILE_NAME}-$$"

# Pull staging from NAS
echo "=== Promote to $TILE_NAME ==="
echo ""
echo "Pulling staging from NAS..."
rm -rf "$LOCAL_STAGING"
mkdir -p "$LOCAL_STAGING"

# Pull skills
if [ "$MODE" != "--rules-only" ]; then
  SKILLS_ON_NAS=$(nas "ls '$STAGING_BASE/skills/' 2>/dev/null" || true)
  if [ -n "$SKILLS_ON_NAS" ]; then
    for skill in $SKILLS_ON_NAS; do
      [ -z "$skill" ] && continue
      if [ "$MODE" != "all" ] && [ "$skill" != "$MODE" ]; then continue; fi
      mkdir -p "$LOCAL_STAGING/skills/$skill"
      nas "tar czf - -C '$STAGING_BASE/skills/$skill' ." | tar xzf - -C "$LOCAL_STAGING/skills/$skill"
      echo "  pulled skill: $skill"
    done
  fi
fi

# Pull rules
if [ "$MODE" = "all" ] || [ "$MODE" = "--rules-only" ]; then
  RULES_ON_NAS=$(nas "if [ -d '$STAGING_BASE/rules' ]; then ls '$STAGING_BASE/rules/' 2>/dev/null; fi" || true)
  if [ -n "$RULES_ON_NAS" ]; then
    mkdir -p "$LOCAL_STAGING/rules"
    for rule in $RULES_ON_NAS; do
      [ -z "$rule" ] && continue
      nas "cat '$STAGING_BASE/rules/$rule'" > "$LOCAL_STAGING/rules/$rule"
      echo "  pulled rule: $rule"
    done
  fi
fi

echo ""

# Set up cross-tile duplicate check via NAS registry
export TESSL_TILES_DIR=""
export GITHUB_TOKEN="${GITHUB_TOKEN:-$(grep GITHUB_TOKEN "$PROJECT_ROOT/.env" | cut -d= -f2)}"
export TILE_OWNER="${TILE_OWNER:-$(grep TILE_OWNER "$PROJECT_ROOT/.env" | cut -d= -f2)}"
export TILE_OWNER="${TILE_OWNER:-jbaruch}"
export ASSISTANT_NAME="${ASSISTANT_NAME:-$(grep ASSISTANT_NAME "$PROJECT_ROOT/.env" | cut -d= -f2)}"

# Run the core promote script
"$PROJECT_ROOT/scripts/promote-to-tile-repo.sh" "$LOCAL_STAGING" "$TILE_NAME" "$MODE"

rm -rf "$LOCAL_STAGING"
