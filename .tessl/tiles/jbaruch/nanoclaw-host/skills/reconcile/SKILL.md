---
name: reconcile
description: Verify that all tessl tiles are in sync between git source, tessl registry, and the NAS orchestrator. Reports drift, unpublished content, untracked files, and version mismatches. Use when tile state seems wrong, container behavior looks stale, you suspect out-of-sync tiles, or need to check tile health before a release. Run after promoting skills or after any manual tile edits.
---

# Reconcile Tiles

Full reconciliation check across all three tile locations.

## Usage

```bash
./scripts/reconcile-tiles.sh
```

## What it checks

1. **Registry vs git** — diffs every rule and skill file between the registry-installed tiles and the git source baked into the orchestrator image
2. **Untracked files** — checks for stale files on the NAS that aren't in git (leftover from manual copies)
3. **Version alignment** — compares local tile.json version with the version installed in the orchestrator

## Exit codes

- `0` — all clean
- `1` — issues found (printed to stdout)

## Issue types

| Label | Meaning | Fix |
|-------|---------|-----|
| DRIFT | Registry and git have different content | Publish the tile to push git changes into the registry |
| GIT-ONLY | File in git but not in registry | Publish the tile to register the missing file |
| REGISTRY-ONLY | File in registry but not in git | Investigate — may be stale; remove from registry if confirmed orphaned |
| MISMATCH | Version numbers don't match | Publish the tile if git is ahead, or re-install if registry is ahead |
| Untracked | Files on NAS not in git | Delete the untracked files from the NAS |

## Remediation workflow

Run reconcile, fix each reported issue, then re-run to confirm a clean result:

```bash
# 1. Run reconcile and capture output
./scripts/reconcile-tiles.sh

# 2. For each reported issue, apply the fix from the table above

# 3. Re-run to verify all issues are resolved
./scripts/reconcile-tiles.sh
```

Repeat until the script exits `0`.

## When to run

- After every promote cycle
- After manual tile edits
- When container behavior seems stale or wrong
- Before creating a release or snapshot
