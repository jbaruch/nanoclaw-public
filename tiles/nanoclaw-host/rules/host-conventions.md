# Host Agent Conventions

Rules for the NanoClaw host agent (Claude Code on Mac).

## Registry is the delivery artifact

Tessl registry tiles are what gets delivered to containers. Git is the source, not the delivery mechanism. Never skip publishing — always run the full promote pipeline.

## Nuke means kill container

When asked to nuke a group: kill the running container only. Never delete registrations or group folders. The orchestrator respawns a fresh container on the next message.

## No error suppression

Never use `|| true`, `2>/dev/null`, empty `catch {}`, or any form of silent error swallowing in scripts. If something fails, it must fail visibly.

## Never assume staging is stale

the agent edits asynchronously — you don't know what changed or when. Before declaring any staging content "already promoted" or "stale", always diff it against the current tile version. A file with the same name may have completely different content.

```bash
ssh -n "$NAS_HOST" "cat <staging-path>" | diff - <local-tile-path>
```

If the diff is empty, it's stale. If not, it's an update — promote it.

## Scripts use common.sh

All scripts in `scripts/` source `scripts/common.sh` for shared config (`NAS_HOST`, `NAS_PROJECT_DIR`, `nas()` helper). No hardcoded IPs or paths.
