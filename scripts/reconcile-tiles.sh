#!/usr/bin/env bash
# Reconcile tiles: compare tile GitHub repos vs registry-installed in orchestrator.
# Reports version mismatches and missing tiles.
#
# Usage:
#   ./scripts/reconcile-tiles.sh

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

TILE_OWNER_VAL=$(grep TILE_OWNER "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2)
TILE_OWNER_VAL="${TILE_OWNER_VAL:-jbaruch}"

TILES="nanoclaw-admin nanoclaw-core nanoclaw-trusted nanoclaw-untrusted nanoclaw-host"
ISSUES=0

echo "=== Tile Reconciliation ==="
echo ""

echo "Tile versions (repo vs registry):"
for tile in $TILES; do
  # Get version from tile GitHub repo
  REPO_VERSION=$(gh api "repos/$TILE_OWNER_VAL/$tile/contents/tile.json" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])" 2>/dev/null)
  if [ -z "$REPO_VERSION" ]; then
    echo "  $tile: repo NOT FOUND"
    ISSUES=$((ISSUES + 1))
    continue
  fi

  # Get version installed in orchestrator
  INSTALLED_VERSION=$(nas "docker exec nanoclaw cat /app/tessl-workspace/.tessl/tiles/${TILE_OWNER_VAL}/$tile/tile.json 2>/dev/null" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])" 2>/dev/null)
  if [ -z "$INSTALLED_VERSION" ]; then
    echo "  $tile: repo=$REPO_VERSION installed=NOT FOUND"
    ISSUES=$((ISSUES + 1))
    continue
  fi

  # Get latest version in tessl registry
  REGISTRY_VERSION=$(tessl tile info "$TILE_OWNER_VAL/$tile" 2>/dev/null | grep 'Latest Version' | awk '{print $NF}')

  if [ "$REPO_VERSION" = "$INSTALLED_VERSION" ]; then
    echo "  $tile: $REPO_VERSION (in sync)"
  elif [ "$REGISTRY_VERSION" = "$INSTALLED_VERSION" ]; then
    echo "  $tile: repo=$REPO_VERSION registry=$REGISTRY_VERSION installed=$INSTALLED_VERSION (repo ahead — GHA may be pending)"
  else
    echo "  $tile: repo=$REPO_VERSION registry=$REGISTRY_VERSION installed=$INSTALLED_VERSION (MISMATCH)"
    ISSUES=$((ISSUES + 1))
  fi
done

echo ""

# Check for pending staging on NAS
echo "Pending staging:"
STAGING=$(nas "find $NAS_PROJECT_DIR/groups/*/staging -type f -name '*.md' 2>/dev/null" || true)
if [ -n "$STAGING" ]; then
  echo "$STAGING" | while read -r f; do
    echo "  ${f#$NAS_PROJECT_DIR/}"
  done
else
  echo "  (empty)"
fi

echo ""

# Check GHA status for recent failures
echo "Latest GHA runs:"
for tile in $TILES; do
  result=$(gh run list --repo "$TILE_OWNER_VAL/$tile" --limit 1 --json status,conclusion --jq '.[0] | "\(.conclusion)"' 2>/dev/null)
  if [ "$result" = "failure" ]; then
    echo "  $tile: FAILED"
    ISSUES=$((ISSUES + 1))
  else
    echo "  $tile: $result"
  fi
done

echo ""
if [ "$ISSUES" -gt 0 ]; then
  echo "$ISSUES issue(s) found."
  exit 1
else
  echo "All clean."
fi
