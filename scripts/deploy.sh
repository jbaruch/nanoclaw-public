#!/usr/bin/env bash
# Full NanoClaw deployment — single command, no manual steps.
#
# Usage: ssh nas "cd ~/nanoclaw && ./scripts/deploy.sh"
#    or: ssh nas "cd ~/nanoclaw && ./scripts/deploy.sh --tiles-only"
#
# Steps:
#   1. Pull latest code from origin
#   2a. Rebuild agent-runner image (must precede 2b — see #69)
#   2b. Rebuild orchestrator image (`docker compose up -d --build`
#       recreates the running container as a side effect of the rebuild)
#   3. Update tiles from registry
#   4. Clear runtime skill overrides from all groups
#   5. Kill ALL running agent containers (forces fresh tile load)
#   6. Clear ALL sessions from DB
#   7. Restart orchestrator
#
# The --tiles-only flag skips the git pull and image rebuilds (for when
# only tile content changed, not source code).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Read CONTAINER_IMAGE from .env if it isn't already set in the shell,
# so this script and `docker compose` see the same source of truth.
# `docker compose` reads .env directly when interpolating
# `${CONTAINER_IMAGE:-...}`; without this lookup, a `.env`-only setting
# would be visible to compose but invisible to this script — silent
# divergence, "we rebuild what the orchestrator spawns" stops being
# true.
#
# Two design choices worth preserving:
#   1. Parse `.env` as data, NOT `source .env`. Sourcing executes the
#      file as shell code — any unexpected/malicious content runs on
#      the host. We only want one specific KEY=VALUE, not arbitrary
#      shell.
#   2. Shell-exported values WIN over `.env`. That matches `docker
#      compose`'s precedence (shell env overrides .env). Without this
#      check, `set -a + source .env` would overwrite an explicit shell
#      export — operator surprise.
if [ -f .env ] && [ -z "${CONTAINER_IMAGE:-}" ]; then
    # Match the first line that looks like `CONTAINER_IMAGE=<value>`
    # (ignoring `# CONTAINER_IMAGE=` comments and indented variants).
    # `grep -m1` stops after the first match — a single tool, no `head`
    # pipe (which would close stdin and hand grep a SIGPIPE under
    # `set -o pipefail`). `|| true` swallows the no-match exit-1 so a
    # `.env` that doesn't define CONTAINER_IMAGE leaves us at the
    # default rather than aborting the script under `set -e`.
    # Strip surrounding double or single quotes if present, the way
    # compose's .env parser does.
    raw=$(grep -m1 -E '^[[:space:]]*CONTAINER_IMAGE=' .env | sed -E 's/^[[:space:]]*CONTAINER_IMAGE=//' || true)
    if [ -n "$raw" ]; then
        # Strip matching quote pair if present
        case "$raw" in
            \"*\") raw="${raw#\"}"; raw="${raw%\"}";;
            \'*\') raw="${raw#\'}"; raw="${raw%\'}";;
        esac
        export CONTAINER_IMAGE="$raw"
    fi
fi

TILES_ONLY=false
if [[ "${1:-}" == "--tiles-only" ]]; then
    TILES_ONLY=true
fi

echo "=== NanoClaw Deploy ==="
echo ""

# 0. Guard against credentials embedded in the git remote URL (#106).
# Any `https://<user>:<token>@github.com/...` form leaks the token to
# anyone who runs `git remote -v`, reads `.git/config`, or sees a
# script's stdout when this script echoes git output. PATs with `repo`
# scope grant full read/write — leaking one is a high-severity rotate-
# now incident. Refuse to deploy until the operator switches to SSH or
# a credential helper. Pattern matches both `https://user:token@host/`
# and the GitHub-specific `x-access-token:token@host/` shape seen on
# the NAS in #106.
echo "0. Checking git remote for embedded credentials..."
if git remote -v 2>/dev/null | grep -qE 'https?://[^@/[:space:]]+:[^@/[:space:]]+@'; then
    echo "ERROR: git remote URL embeds credentials." >&2
    echo "  PATs in remote URLs leak via 'git remote -v', .git/config, and any" >&2
    echo "  script that echoes git output. Rotate the credential and switch to" >&2
    echo "  SSH:" >&2
    echo "    git remote set-url origin git@github.com:<owner>/<repo>.git" >&2
    echo "  or to a credential helper backed by a secret store. Refusing to" >&2
    echo "  deploy. See https://github.com/jbaruch/nanoclaw/issues/106" >&2
    exit 1
fi
echo ""

# 1. Pull
if [[ "$TILES_ONLY" == false ]]; then
    echo "1. Pulling latest code..."
    # `git stash` exits non-zero when there's nothing to stash — expected case on a clean tree.
    git stash 2>/dev/null || true
    git pull --no-rebase origin main
    echo ""

    # 2. Rebuild agent-runner + orchestrator.
    # Order matters: build the AGENT image first, then rebuild+restart
    # the ORCHESTRATOR. The reverse order leaves a window where the new
    # orchestrator is live but `nanoclaw-agent:latest` still points at
    # the pre-deploy image — any inbound message in that window spawns
    # an agent from the stale image (issue #69, the same stale-image
    # class of bug as #66 was meant to close).
    #
    # Doing agent first means: while build.sh runs, the OLD orchestrator
    # is still serving requests against the OLD agent image — i.e. the
    # pre-deploy steady state, not a regression. By the time the
    # orchestrator is recreated by `docker compose up -d --build`, the
    # agent image is already new.
    #
    # Orchestrator image bakes the host-side TypeScript compiled output;
    # agent-runner image bakes container-side source (MCP tools, IPC
    # bridge). Both need rebuilding after a source-code pull — previous
    # versions of this script only built the orchestrator, which left
    # the agent image stale (last observed when `nuke_session` got a
    # new `session` parameter on the schema: the schema was in git but
    # Andy's container still saw the old parameterless tool until
    # someone remembered to run `./container/build.sh` separately).
    #
    # Agent-image reference comes from $CONTAINER_IMAGE (the same env
    # var the orchestrator reads in src/config.ts to decide which image
    # to spawn agent containers from). When unset we default to
    # `nanoclaw-agent:latest`; otherwise we honor whatever tag the
    # operator passed (versioned, custom name, etc.). Digest-pinned
    # references like `nanoclaw-agent:latest@sha256:...` are NOT
    # supported by `./container/build.sh` and are detected below — we
    # warn and let the orchestrator continue spawning from the
    # operator-pinned image without trying to rebuild it locally.
    echo "2a. Rebuilding agent-runner..."
    AGENT_IMAGE="${CONTAINER_IMAGE:-nanoclaw-agent:latest}"
    # build.sh reads the tag from the first POSITIONAL arg, not env var
    # (`TAG="${1:-latest}"`). Passing as env var would be silently
    # ignored and default to `latest` — the exact stale-image bug this
    # PR is meant to prevent.
    if [[ "$AGENT_IMAGE" == *@sha256:* ]]; then
        # Digest-pinned reference. Docker accepts both `name:tag@sha256:...`
        # and `name@sha256:...` (digest-only, no tag) — match either via
        # `*@sha256:*`. `./container/build.sh "$tag"` doesn't accept a
        # digest and would produce an invalid `docker build -t` arg.
        # The orchestrator already pins to this exact image regardless
        # of what we rebuild locally, so warn and skip — the operator's
        # external build pipeline owns this image, not us.
        echo "WARNING: CONTAINER_IMAGE='$AGENT_IMAGE' is digest-pinned; skipping local agent rebuild."
        echo "WARNING: The orchestrator will continue spawning from the pinned digest as-is."
    elif [[ "$AGENT_IMAGE" == nanoclaw-agent:* ]]; then
        AGENT_TAG="${AGENT_IMAGE#nanoclaw-agent:}"
        # Guard against CONTAINER_IMAGE="nanoclaw-agent:" (trailing colon,
        # empty tag). build.sh's `${1:-latest}` only defaults on UNSET/
        # missing — an explicitly-passed empty string stays empty and
        # would build the invalid reference `nanoclaw-agent:`. Fall back
        # to latest with a warning so the operator notices the typo.
        if [[ -z "$AGENT_TAG" ]]; then
            echo "WARNING: CONTAINER_IMAGE='$AGENT_IMAGE' has an empty tag; building nanoclaw-agent:latest instead."
            ./container/build.sh
        else
            ./container/build.sh "$AGENT_TAG"
        fi
    elif [[ "$AGENT_IMAGE" == "nanoclaw-agent" ]]; then
        ./container/build.sh
    else
        echo "WARNING: CONTAINER_IMAGE='$AGENT_IMAGE' is not local nanoclaw-agent:*"
        echo "WARNING: ./container/build.sh will rebuild nanoclaw-agent:latest,"
        echo "WARNING: which is NOT the image the orchestrator will spawn from."
        echo "WARNING: Push/tag your own build pipeline for '$AGENT_IMAGE' separately."
        ./container/build.sh
    fi
    echo ""

    # `docker compose up -d --build` rebuilds the orchestrator image AND
    # recreates the running container as a side effect — the explicit
    # restart in step 7 is a separate clean-state pass after steps 3-6
    # have mutated DB and FS, not a duplicate of this one.
    #
    # Residual race window: while THIS step's image build is in flight,
    # the OLD orchestrator stays up and may spawn agents from the agent
    # tag (`$AGENT_IMAGE`, defaulting to nanoclaw-agent:latest but
    # operator-overridable via $CONTAINER_IMAGE) — which step 2a JUST
    # repointed at the new agent image. So during the 2b build window
    # the system runs with
    # OLD orchestrator + NEW agent, NOT pre-deploy steady state. We
    # accept this asymmetry per #69's Option 1: the pre-fix bug had the
    # orchestrator already recreated to the NEW image while the agent
    # image was still OLD — exactly the contract violation #66 was
    # meant to close. The post-fix old-orchestrator/new-agent combo is
    # the kind of asymmetry any rolling deploy temporarily exposes,
    # not a fresh-spawn-from-stale-agent. Option 3 — pre-build both
    # images then atomic-swap — would close the residual race entirely
    # but adds complexity not worth the cost for a personal deploy.
    echo "2b. Rebuilding orchestrator..."
    docker compose up -d --build
    echo ""
else
    echo "1-2b. Skipped (--tiles-only)"
    echo ""
fi

# 3. Update tiles
echo "3. Updating tiles from registry..."
docker exec nanoclaw sh -c 'cd /app/tessl-workspace && tessl update --yes --dangerously-ignore-security 2>&1' | tail -10
echo ""

# 3b. Verify no literal pins crept into tessl-workspace/tessl.json.
#
# Per `nanoclaw-host: tessl-version-floating` (registry 0.1.25+), every
# `dependencies.<tile>.version` in this manifest MUST be the literal
# string "latest" — an approved exception to `coding-policy:
# dependency-management` for this one file. `tessl install <tile>`
# writes a literal pin by default, so an operator hand-installing a
# new tile (or merging a fork) can quietly reintroduce drift; this
# check fails the deploy when that happens.
echo "3b. Verifying tessl-workspace/tessl.json uses 'latest' for every dependency..."
PINNED_OFFENDERS=$(python3 - <<'PY'
import json, sys, pathlib
manifest = pathlib.Path("tessl-workspace/tessl.json")
data = json.loads(manifest.read_text())
bad = [
    name for name, dep in data.get("dependencies", {}).items()
    if dep.get("version") != "latest"
]
if bad:
    print("\n".join(bad))
PY
)
if [[ -n "$PINNED_OFFENDERS" ]]; then
    echo "ERROR: tessl-workspace/tessl.json has non-'latest' pins:" >&2
    echo "$PINNED_OFFENDERS" | sed 's/^/  - /' >&2
    echo "Fix: edit each entry to {\"version\": \"latest\"} and re-run deploy." >&2
    echo "Why: nanoclaw-host: tessl-version-floating (approved exception to coding-policy: dependency-management)." >&2
    exit 1
fi
echo "  ok — all dependencies float to latest"
echo ""

# 4. Clear runtime skill overrides from all groups
# NOTE: staging/ is NOT cleared here — that's verify-tiles' job after promotion.
echo "4. Clearing runtime skill overrides..."
OVERRIDE_COUNT=0
for group_dir in groups/*/; do
    skills_dir="${group_dir}skills"
    if [[ -d "$skills_dir" ]] && [[ -n "$(ls -A "$skills_dir" 2>/dev/null)" ]]; then
        echo "  cleaning: $skills_dir"
        rm -rf "${skills_dir:?}"/*
        OVERRIDE_COUNT=$((OVERRIDE_COUNT + 1))
    fi
done
echo "  cleaned $OVERRIDE_COUNT group(s) with overrides"
echo ""

# 5. Kill ALL agent containers
echo "5. Killing all agent containers..."
# `grep` exits 1 when no agents match — the empty-string case is handled by the `-n` check below.
AGENTS=$(docker ps --format '{{.Names}}' | grep '^nanoclaw-' | grep -v '^nanoclaw$' || true)
if [[ -n "$AGENTS" ]]; then
    # A container may exit between the `docker ps` above and the kill below;
    # `docker kill` on an already-dead container is a benign race, not a failure.
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

# 7. Restart orchestrator (final clean-state restart).
# Step 2b's `up -d --build` already recreated the container on the new
# image, but steps 3-6 mutated DB state (sessions cleared, agents killed,
# tiles refreshed). Restart again so the running orchestrator process
# loads from a clean post-cleanup state instead of running with whatever
# in-memory caches were warm before steps 3-6. Cheap (no rebuild —
# `restart` reuses the image from 2b); avoids subtle staleness bugs.
echo "7. Restarting orchestrator..."
docker compose restart nanoclaw
echo ""

echo "=== Deploy complete ==="
echo "All groups will get fresh tiles on next message."
