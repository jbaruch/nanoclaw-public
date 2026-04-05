#!/usr/bin/env bash
# Full NanoClaw deployment — single command, no manual steps.
#
# Usage: ssh nas "cd ~/nanoclaw && ./scripts/deploy.sh"
#    or: ssh nas "cd ~/nanoclaw && ./scripts/deploy.sh --tiles-only"
#
# Steps:
#   1. Pull latest code from origin
#   2. Rebuild orchestrator container
#   3. Update tiles from registry
#   4. Kill ALL running agent containers (forces fresh tile load)
#   5. Clear ALL sessions from DB
#   6. Restart orchestrator
#
# The --tiles-only flag skips the git pull and orchestrator rebuild
# (for when only tile content changed, not source code).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TILES_ONLY=false
if [[ "${1:-}" == "--tiles-only" ]]; then
    TILES_ONLY=true
fi

echo "=== NanoClaw Deploy ==="
echo ""

# 1. Pull
if [[ "$TILES_ONLY" == false ]]; then
    echo "1. Pulling latest code..."
    git stash 2>/dev/null || true
    git pull --no-rebase origin main
    echo ""

    # 2. Rebuild orchestrator
    echo "2. Rebuilding orchestrator..."
    docker compose up -d --build
    echo ""
else
    echo "1-2. Skipped (--tiles-only)"
    echo ""
fi

# 3. Update tiles
echo "3. Updating tiles from registry..."
docker exec nanoclaw sh -c 'cd /app/tessl-workspace && tessl update --yes --dangerously-ignore-security 2>&1' | tail -10
echo ""

# 4. Clear staging overrides from all groups
echo "4. Clearing staging overrides..."
STAGING_COUNT=0
for group_dir in groups/*/; do
    skills_dir="${group_dir}skills"
    if [[ -d "$skills_dir" ]] && [[ -n "$(ls -A "$skills_dir" 2>/dev/null)" ]]; then
        echo "  cleaning: $skills_dir"
        rm -rf "${skills_dir:?}"/*
        ((STAGING_COUNT++))
    fi
    staging_dir="${group_dir}staging"
    if [[ -d "$staging_dir" ]] && [[ -n "$(ls -A "$staging_dir" 2>/dev/null)" ]]; then
        echo "  cleaning: $staging_dir"
        rm -rf "${staging_dir:?}"/*
        ((STAGING_COUNT++))
    fi
done
echo "  cleaned $STAGING_COUNT group(s) with staging"
echo ""

# 5. Kill ALL agent containers
echo "5. Killing all agent containers..."
AGENTS=$(docker ps --format '{{.Names}}' | grep '^nanoclaw-' | grep -v '^nanoclaw$' || true)
if [[ -n "$AGENTS" ]]; then
    echo "$AGENTS" | xargs docker kill 2>/dev/null || true
    echo "  killed: $(echo "$AGENTS" | wc -l | tr -d ' ') containers"
else
    echo "  no agent containers running"
fi
echo ""

# 6. Clear sessions
echo "6. Clearing all sessions..."
sqlite3 store/messages.db 'DELETE FROM sessions'
CLEARED=$(sqlite3 store/messages.db 'SELECT changes()')
echo "  cleared $CLEARED sessions"
echo ""

# 7. Restart orchestrator
echo "7. Restarting orchestrator..."
docker compose restart nanoclaw
echo ""

echo "=== Deploy complete ==="
echo "All groups will get fresh tiles on next message."
