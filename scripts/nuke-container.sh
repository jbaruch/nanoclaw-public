#!/usr/bin/env bash
# Kill the running container for a Telegram group. The orchestrator respawns
# a fresh one on the next message.
#
# Usage:
#   ./scripts/nuke-container.sh tg:-1001234567890
#   ./scripts/nuke-container.sh tg:-1009876543210
#
# Does NOT touch registration or group folder — only kills the container.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <chat-jid>"
  echo "Example: $0 tg:-1001234567890"
  exit 1
fi

CHAT_JID="$1"

# Look up group folder from the database
GROUP_FOLDER=$(nas "sqlite3 $NAS_PROJECT_DIR/store/messages.db \
  \"SELECT folder FROM registered_groups WHERE jid = '$CHAT_JID';\"")

if [ -z "$GROUP_FOLDER" ]; then
  echo "Error: no registered group for JID $CHAT_JID"
  exit 1
fi

echo "Group: $GROUP_FOLDER (JID: $CHAT_JID)"

# Find running container — name uses hyphens (container-runner replaces non-alphanum with -)
SAFE_NAME=$(echo "$GROUP_FOLDER" | sed 's/[^a-zA-Z0-9-]/-/g')
CONTAINER_ID=$(nas "docker ps --format '{{.ID}} {{.Names}}' \
  | grep 'nanoclaw-${SAFE_NAME}-' \
  | awk '{print \$1}'" || true)

if [ -z "$CONTAINER_ID" ]; then
  echo "No running container for $GROUP_FOLDER"
  exit 0
fi

nas "docker kill $CONTAINER_ID"
echo "Killed container $CONTAINER_ID"
