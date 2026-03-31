#!/bin/bash
set -euo pipefail

# Limit git memory usage to prevent SIGBUS under container memory pressure
git config --global pack.threads 1
git config --global pack.deltaCacheSize 1m
git config --global pack.windowMemory 100m

# Agent-runner is pre-compiled at image build time (/app/dist/).

# Wire tessl rules chain into workspace (first-time setup for new groups).
# .tessl/ and skills/ are populated host-side by container-runner.
# May fail on read-only filesystems (untrusted groups) — non-fatal.
if [ -w /workspace/group ]; then
  if [ -d /home/node/.claude/.tessl ] && [ ! -d /workspace/group/.tessl ]; then
    cp -rL /home/node/.claude/.tessl /workspace/group/.tessl
    echo "[entrypoint] Copied .tessl to workspace" >&2
  fi
  if [ -f /home/node/.claude/.tessl/RULES.md ] && [ ! -f /workspace/group/AGENTS.md ]; then
    cat > /workspace/group/AGENTS.md << 'AGENTS_EOF'


# Agent Rules <!-- managed by orchestrator -->

@.tessl/RULES.md follow the [instructions](.tessl/RULES.md)
AGENTS_EOF
    echo "[entrypoint] Created AGENTS.md" >&2
  fi
fi

# Read container input from stdin and run the agent
cat > /tmp/input.json
node /app/dist/index.js < /tmp/input.json
