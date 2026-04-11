---
name: promote
description: Promote agent-created skills and rules from NAS staging to tile GitHub repos. Runs tessl skill review --optimize locally before pushing, so GHA review passes first try. Use when there are new items on staging, after check-staging shows pending items, or when asked to deploy skills, push to production, or publish rules to a tile repo.
---

# Promote from Staging

Promotes skills and rules from the agent's NAS staging area to tile GitHub repos via `scripts/promote-to-tile-repo.sh`.

## Before promoting

Run `./scripts/check-staging.sh` to see what's pending. Review each item before promoting.

## Determine the target tile

Each item belongs to exactly one tile:

| Content | Target tile | GitHub repo |
|---------|------------|-------------|
| Admin/operational skills | `nanoclaw-admin` | jbaruch/nanoclaw-admin (private) |
| Trusted shared operational | `nanoclaw-trusted` | jbaruch/nanoclaw-trusted |
| Security rules for untrusted | `nanoclaw-untrusted` | jbaruch/nanoclaw-untrusted |
| Shared behavior (all containers) | `nanoclaw-core` | jbaruch/nanoclaw-core |
| Host agent conventions | `nanoclaw-host` | jbaruch/nanoclaw-host |

## Run the promote script

```bash
# Promote a specific skill to a tile
TILE_NAME=nanoclaw-admin ./scripts/promote-to-tile-repo.sh heartbeat

# Promote all skills + rules for a tile
TILE_NAME=nanoclaw-admin ./scripts/promote-to-tile-repo.sh all

# Promote only rules
TILE_NAME=nanoclaw-trusted ./scripts/promote-to-tile-repo.sh --rules-only
```

The script:
1. Clones the tile repo from GitHub
2. Validates tile placement (blocks admin content from untrusted/core)
3. Checks for cross-tile duplicates
4. Copies skills and rules into the tile repo clone
5. **Runs `tessl skill review --optimize --yes` on each promoted skill** (shift-left: fixes quality issues before CI)
6. Commits and pushes to the tile repo
7. GitHub Actions runs skill review (85% threshold), lint, and tessl publish

Step 5 requires `tessl` on the host machine. If unavailable, the script warns and skips (GHA still gates).

## After promoting

1. Check the GitHub Actions run on the tile repo to confirm publish succeeded
2. Tell the agent to run `/verify-tiles` to clean up staging copies

## If GHA still fails

The local `tessl skill review --optimize` should prevent most failures. If GHA still fails:
```bash
tessl skill review --optimize --yes tiles/{tile-name}/skills/{skill-name}/SKILL.md
```
Then commit and push to the tile repo.
