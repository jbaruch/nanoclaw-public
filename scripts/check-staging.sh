#!/usr/bin/env bash
# List what's pending on NAS staging (skills + rules).
#
# Usage:
#   ./scripts/check-staging.sh

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
GROUP_FOLDER="${GROUP_FOLDER:-telegram_main}"

SKILLS_DIR="$NAS_PROJECT_DIR/groups/$GROUP_FOLDER/skills"
STAGING_DIR="$NAS_PROJECT_DIR/groups/$GROUP_FOLDER/staging"

echo "=== Staging: $GROUP_FOLDER ==="
echo ""

# Skills (both new and tessl__ overrides)
echo "Skills ($SKILLS_DIR):"
SKILLS=$(nas "ls '$SKILLS_DIR' 2>/dev/null" || true)
if [ -n "$SKILLS" ]; then
  for s in $SKILLS; do
    canonical="${s#tessl__}"
    if [ "$s" != "$canonical" ]; then
      echo "  $canonical (override via tessl__$canonical)"
    else
      echo "  $canonical (new)"
    fi
  done
else
  echo "  (empty)"
fi

echo ""

# Rules (organized by tile)
echo "Rules ($STAGING_DIR):"
RULES=$(nas "find '$STAGING_DIR' -type f -name '*.md' 2>/dev/null" || true)
if [ -n "$RULES" ]; then
  echo "$RULES" | while read -r path; do
    rel="${path#$STAGING_DIR/}"
    echo "  $rel"
  done
else
  echo "  (empty)"
fi
