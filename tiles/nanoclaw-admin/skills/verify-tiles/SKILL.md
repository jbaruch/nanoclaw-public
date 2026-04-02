---
name: verify-tiles
description: Verifies tile installation after promotion — compares installed plugins against staging, removes stale staging copies if content matches, reports mismatches. Runs in a fresh container after plugin promotion. Use after promoting tiles, deploying skill updates, or when installed skill versions appear incorrect or out of date.
---

# Verify Plugin Installation

## Step 1: Compare staging skills against installed plugins

For each skill in `/workspace/group/skills/`, find the corresponding installed version:

```bash
ls /workspace/group/skills/ 2>/dev/null
```

For each `tessl__<name>` directory found:
1. Read staging: `/workspace/group/skills/tessl__<name>/SKILL.md`
2. Read installed tile: find it under `/home/node/.claude/.tessl/tiles/*/` (check nanoclaw-admin, nanoclaw-core, nanoclaw-trusted)
3. Compare using `diff` to detect meaningful changes:

```bash
diff /workspace/group/skills/tessl__<name>/SKILL.md \
     /home/node/.claude/.tessl/tiles/<bucket>/tessl__<name>/SKILL.md
```

**Comparison criteria:**
- **MATCH**: `diff` output is empty or only shows trivial whitespace/punctuation differences
- **MISMATCH**: `diff` shows removed steps, altered rules, changed logic, or missing sections

Alternatively, compare SHA hashes for a quick exact-match check:
```bash
sha256sum /workspace/group/skills/tessl__<name>/SKILL.md
sha256sum /home/node/.claude/.tessl/tiles/<bucket>/tessl__<name>/SKILL.md
```

## Step 2: Act on comparison result

**If MATCH** (staging content is faithfully in the plugin):
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
