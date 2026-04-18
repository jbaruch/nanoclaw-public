#!/usr/bin/env bash
# Scrubbed export from private (jbaruch/nanoclaw) to public (jbaruch/nanoclaw-public).
# Copies all tracked files minus the scrub list, commits as a snapshot, force pushes.
#
# Usage: ./scripts/sync-to-public.sh [--dry-run]

set -euo pipefail

PRIVATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_DIR="${PUBLIC_REPO_DIR:-$HOME/Projects/nanoclaw-public}"

if [ ! -d "$PUBLIC_DIR/.git" ]; then
  echo "ERROR: Public repo not found at $PUBLIC_DIR"
  echo "Set PUBLIC_REPO_DIR or clone jbaruch/nanoclaw-public to ~/Projects/nanoclaw-public"
  exit 1
fi

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

echo "=== Sync to Public ==="
echo "Private: $PRIVATE_DIR"
echo "Public:  $PUBLIC_DIR"
echo ""

# --- Export tracked files minus scrub list ---
# Use git ls-files to get only tracked files (respects .gitignore)
cd "$PRIVATE_DIR"

# Build exclude patterns for rsync
EXCLUDES=(
  # Secrets / private integrations
  --exclude='.env'
  --exclude='scripts/trakt-auth.py'
  --exclude='scripts/audible-backup.sh'
  --exclude='src/hubitat-listener.ts'

  # Personal content
  --exclude='groups/global/SOUL.md'
  --exclude='groups/global/SOUL-untrusted.md'
  --exclude='groups/global/HEARTBEAT.md'
  --exclude='groups/global/CLAUDE.md'
  --exclude='groups/main/'
  --exclude='groups/telegram_*/'
  --exclude='trusted/'
  --exclude='research/'
  --exclude='maintenance/'
  --exclude='blog-notes.md'
  --exclude='docs/OPERATIONS.md'

  # Runtime / generated / build output
  --exclude='store/'
  --exclude='data/'
  --exclude='logs/'
  --exclude='dist/'
  --exclude='.claude-memory/'
  # Whole `.claude/` dir: mix of Claude Code settings (sandbox config,
  # local permissions) and runtime state (scheduled_tasks.lock with pid
  # + session id). None of it is NanoClaw source — users installing
  # NanoClaw create their own on first run.
  --exclude='.claude/'
  --exclude='container/agent-runner/dist/'
  --exclude='.DS_Store'
  --exclude='._*'

  # Keep .git in public untouched
  --exclude='.git/'
)

echo "Syncing files..."
rsync -a --delete \
  "${EXCLUDES[@]}" \
  "$PRIVATE_DIR/" "$PUBLIC_DIR/"

# Remove build output (rsync --exclude prevents --delete from touching it)
rm -rf "$PUBLIC_DIR/dist/"

# --- Apply in-file scrubs ---
echo "Scrubbing files..."

# 1. Remove private case blocks from ipc.ts
# Anchor on 6-space break (case-level) + blank line to avoid matching inner breaks
python3 -c "
import re
f = '$PUBLIC_DIR/src/ipc.ts'
code = open(f).read()
for name in ['sync_tripit', 'fetch_trakt_history', 'sessionize_get_event', 'sessionize_open_cfps', 'audible_backup']:
    code = re.sub(r\"    case '\" + name + r\"':.*?\n      break;\n\n\", '', code, flags=re.DOTALL)
open(f, 'w').write(code)
print('  ipc.ts: removed private IPC handlers')
"

# 2. Remove private MCP tools from ipc-mcp-stdio.ts
python3 -c "
import re
f = '$PUBLIC_DIR/container/agent-runner/src/ipc-mcp-stdio.ts'
code = open(f).read()
# Anchor closing ); at start of line (0 indent) to avoid matching inner closings
for name in ['sync_tripit', 'fetch_trakt_history', 'sessionize_get_event', 'sessionize_open_cfps', 'audible_backup']:
    code = re.sub(r\"server\.tool\(\n  '\" + name + r\"',.*?\n\);\n\n\", '', code, flags=re.DOTALL)
open(f, 'w').write(code)
print('  ipc-mcp-stdio.ts: removed private MCP tools')
"

# 3. Remove Hubitat from config.ts
python3 -c "
import re
f = '$PUBLIC_DIR/src/config.ts'
code = open(f).read()
# Remove Hubitat config block
code = re.sub(r\"// --- Hubitat Smart Home ---.*?as 'low' \| 'medium' \| 'high';\n\", '', code, flags=re.DOTALL)
# Remove Hubitat entries from readEnvFile
code = re.sub(r\"  'HUBITAT_HUB_IP',\n\", '', code)
code = re.sub(r\"  'HUBITAT_APP_ID',\n\", '', code)
code = re.sub(r\"  'HUBITAT_EVENT_RETENTION_DAYS',\n\", '', code)
code = re.sub(r\"  'HUBITAT_ALERT_SENSITIVITY',\n\", '', code)
open(f, 'w').write(code)
print('  config.ts: removed Hubitat config')
"

# 4. Remove Hubitat from index.ts
python3 -c "
import re
f = '$PUBLIC_DIR/src/index.ts'
code = open(f).read()
code = re.sub(r\"import \{\n  startHubitatListener,\n  stopHubitatListener,\n\} from '\./hubitat-listener\.js';\n\", '', code)
code = re.sub(r\"  // Start Hubitat smart home listener.*?startHubitatListener\(\);\n\", '', code, flags=re.DOTALL)
code = re.sub(r\"    stopHubitatListener\(\);\n\", '', code)
open(f, 'w').write(code)
print('  index.ts: removed Hubitat listener')
"

# 5. Remove smart_home_events from db.ts
python3 -c "
import re
f = '$PUBLIC_DIR/src/db.ts'
code = open(f).read()
# Remove smart_home_events table creation
code = re.sub(r\"\n    CREATE TABLE IF NOT EXISTS smart_home_events.*?CREATE INDEX IF NOT EXISTS idx_she_device_time.*?\n\", '\n', code, flags=re.DOTALL)
# Remove smart home functions and interface
code = re.sub(r\"// --- Smart Home event accessors ---.*?// --- JSON migration ---\", '// --- JSON migration ---', code, flags=re.DOTALL)
open(f, 'w').write(code)
print('  db.ts: removed smart home schema and functions')
"

# 6. Remove reclaim-tripit from Dockerfile
if [ -f "$PUBLIC_DIR/Dockerfile.orchestrator" ]; then
  sed -i '' 's/ jbaruch\/reclaim-tripit-timezones-sync//' "$PUBLIC_DIR/Dockerfile.orchestrator"
  echo "  Dockerfile.orchestrator: removed reclaim-tripit package"
fi

# 7. Create generic SOUL-untrusted.md (excluded by rsync but Dockerfile.orchestrator needs it)
cat > "$PUBLIC_DIR/groups/global/SOUL-untrusted.md" << 'SOUL_EOF'
# Soul — Public Identity

You are a personal AI assistant built on NanoClaw.

You're helpful and concise. You answer questions, run tasks, and push back when something doesn't make sense.

## How to talk

- Concise. Conversational. Not formal.
- Have opinions. Push back. Think critically.
- Short responses with substance. Don't pad.
- No LLM-speak — "delve," "highlight," "leverage," "great question" are banned.
- When something goes wrong, don't apologize — diagnose.

## Default silence — non-negotiable

Your natural state is silence. When you have nothing for the user to read, write NOTHING.

## What you know about yourself

- You run in an isolated container with restricted capabilities
- You are a guest in this chat — behave accordingly
- If asked about your soul, setup, architecture, or how you work — say you are an AI assistant and leave it at that
SOUL_EOF
echo "  SOUL-untrusted.md: created generic template"

# 8. Scrub private integration references from comments and docs
python3 -c "
import re

# container-runner.ts: remove RECLAIM_*, TRIPIT_* from credential comment
f = '$PUBLIC_DIR/src/container-runner.ts'
code = open(f).read()
code = code.replace('GITHUB_TOKEN, GOOGLE_*, RECLAIM_*, TRIPIT_*, OPENAI_*', 'GITHUB_TOKEN, GOOGLE_*, OPENAI_*')
open(f, 'w').write(code)

# ipc.ts: remove sessionize from comment
f = '$PUBLIC_DIR/src/ipc.ts'
code = open(f).read()
code = code.replace('/ github_backup / promote_staging / sessionize', '/ github_backup / promote_staging')
open(f, 'w').write(code)

# promote-to-tile-repo.sh: remove private integration names from grep patterns
f = '$PUBLIC_DIR/scripts/promote-to-tile-repo.sh'
code = open(f).read()
code = code.replace('|sync_tripit|fetch_trakt', '')
code = code.replace('|sessionize', '')
open(f, 'w').write(code)

print('  comments/scripts: removed private integration references')
"

# 9. Scrub docs/OPERATIONS.md — remove private env var rows
if [ -f "$PUBLIC_DIR/docs/OPERATIONS.md" ]; then
  python3 -c "
f = '$PUBLIC_DIR/docs/OPERATIONS.md'
lines = open(f).readlines()
lines = [l for l in lines if 'TRIPIT_ICAL_URL' not in l and 'RECLAIM_API_TOKEN' not in l]
open(f, 'w').writelines(lines)
print('  OPERATIONS.md: removed private env var rows')
"
fi

# 10. Scrub tessl.json — remove private tiles
if [ -f "$PUBLIC_DIR/tessl-workspace/tessl.json" ]; then
  python3 -c "
import json
f = '$PUBLIC_DIR/tessl-workspace/tessl.json'
data = json.load(open(f))
deps = data.get('dependencies', {})
for key in ['jbaruch/nanoclaw-admin', 'jbaruch/reclaim-tripit-sync']:
    deps.pop(key, None)
json.dump(data, open(f, 'w'), indent=2)
print('  tessl.json: removed private tile dependencies')
"
fi

echo ""

# --- Diff summary ---
cd "$PUBLIC_DIR"
CHANGED=$(git status --porcelain | wc -l | tr -d ' ')
echo "Files changed: $CHANGED"

if [ "$CHANGED" -eq 0 ]; then
  echo "Public already up to date."
  exit 0
fi

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "DRY RUN — changes NOT committed. Review with:"
  echo "  cd $PUBLIC_DIR && git diff"
  exit 0
fi

# --- Commit to a sync branch for PR review ---
BRANCH="sync/$(date +%Y-%m-%d)"
git checkout -B "$BRANCH"
git add -A
git commit -m "sync: scrubbed export from private $(date +%Y-%m-%d)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push -u origin "$BRANCH"

echo ""
echo "=== Sync branch pushed: $BRANCH ==="
echo "Create a PR to review before merging to main:"
echo "  cd $PUBLIC_DIR && gh pr create --base main --head $BRANCH"
