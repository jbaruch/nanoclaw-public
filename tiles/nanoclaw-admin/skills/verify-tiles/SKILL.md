---
name: verify-tiles
description: Verifies tile installation after promotion — compares installed tiles against staging, removes stale staging copies if content matches, reports mismatches. Runs in a fresh container after the previous container was replaced by promote-tiles. Use after promoting tiles, when skill versions seem outdated or incorrect, when installed skills don't reflect recent changes, or to confirm a promotion completed successfully.
---

# Verify Tile Installation

## Step 1: Compare staging skills against installed tiles

For each skill in `/workspace/group/skills/`, find the corresponding installed version:

```bash
ls /workspace/group/skills/ 2>/dev/null
```

For each `tessl__<name>` directory found:
1. Read staging: `/workspace/group/skills/tessl__<name>/SKILL.md`
2. Read installed tile: `/home/node/.claude/.tessl/tiles/${TILE_OWNER}/nanoclaw-admin/skills/<name>/SKILL.md` (or `nanoclaw-core/...`)
3. Compare using `diff` to surface concrete differences:
   ```bash
   diff /workspace/group/skills/tessl__<name>/SKILL.md \
        "/home/node/.claude/.tessl/tiles/${TILE_OWNER}/nanoclaw-admin/skills/<name>/SKILL.md"
   ```
   - **Small wording differences** (whitespace, punctuation, minor rephrasing with same meaning) → treat as **MATCH**
   - **Structural or logic differences** (missing steps, removed rules, changed conditions, added/removed bash commands) → treat as **MISMATCH**
   - If the diff is empty → **MATCH**

## Step 2: Act on comparison result

**If MATCH** (staging content is faithfully in the tile):
```bash
rm -rf /workspace/group/skills/tessl__<name>
```
Note: "Removed stale staging: <name>"

**If MISMATCH** (tile differs from staging):
- Keep the staging copy
- Note the discrepancy (which steps or rules differ)

**If no installed tile found** (skill not promoted yet):
- Keep the staging copy — it's a work in progress

## Step 3: Check staging rules

```bash
find /workspace/group/staging -type f -name "*.md" 2>/dev/null
```

For each rule file found — it was already promoted (promote_staging handles rules). Remove it:
```bash
find /workspace/group/staging -type f -name "*.md" -delete 2>/dev/null
find /workspace/group/staging -type d -empty -delete 2>/dev/null
```

## Step 4: Report

Send report via `mcp__nanoclaw__send_message`:

```
✅ Tile verification complete:
• Removed N stale staging copies: [names]
• Kept M staging-only skills (not yet promoted): [names]
• MISMATCH on K skills (kept): [names + what differs]
• Removed J rule files from staging
```

If staging was already empty — just say so briefly.
