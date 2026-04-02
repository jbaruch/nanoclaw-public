---
name: promote
description: Promote the agent-created skills and rules from NAS staging to tessl tiles. Runs the full pipeline — pull, optimize, lint, commit, push, deploy, publish, install. Use when the user says there are new items on staging, or after check-staging shows pending items.
---

# Promote from Staging

Promotes skills and rules from the agent's NAS staging area to tessl tiles via `scripts/promote-skill.sh`.

## Before promoting

Run `./scripts/check-staging.sh` to see what's pending. Review each item before promoting.

## Determine the target tile

Each item belongs to exactly one tile:

| Content | Target tile |
|---------|------------|
| Admin/operational skills (scheduled tasks, management, monitoring) | `nanoclaw-admin` |
| Security rules for untrusted groups | `nanoclaw-untrusted` |
| Shared behavior (all containers) | `nanoclaw-core` |

## Run the promote script

```bash
# Promote a specific skill
echo y | TILE_NAME=nanoclaw-admin ./scripts/promote-skill.sh soul-review

# Promote all skills + rules for a tile
echo y | TILE_NAME=nanoclaw-admin ./scripts/promote-skill.sh

# Promote only rules
echo y | TILE_NAME=nanoclaw-untrusted ./scripts/promote-skill.sh --rules-only
```

The script handles both staging paths:
- `skills/{name}/SKILL.md` — new skills
- `skills/tessl__{name}/SKILL.md` — patches to existing tile skills

## After promoting

1. Run `./scripts/reconcile-tiles.sh` to verify everything is in sync
2. Tell the agent to run `/verify-tiles` to clean up staging copies

## If publish times out

The script falls back to git-only deploy. Re-publish manually:

```bash
tessl tile publish --bump patch tiles/{tile-name}
```

Then commit the version bump, push, and install in the orchestrator.
