---
name: promote-tiles
description: "Promotes staged skills and rules to tiles, then schedules nuke (20 min) and verify (21 min) so verify runs in a fresh container after tessl review+optimize completes. Use when the user wants to promote, deploy, or push staged skills or rules to tiles, or invokes /promote-tiles."
---

# Promote Plugins

## Step 1: Check what's staged

```bash
ls /workspace/group/skills/ 2>/dev/null
find /workspace/group/staging -type f -name "*.md" 2>/dev/null
```

**If nothing is staged**, stop immediately and send a message indicating there is nothing staged to promote. Do not proceed to the remaining steps.

## Staging paths

**Skills** — two paths, both work:
- `/workspace/group/skills/{name}/SKILL.md` — new skills (works at runtime + staging)
- `/workspace/group/skills/tessl__{name}/SKILL.md` — patches to existing plugin skills

**Rules** → `/workspace/group/staging/{tile-name}/{name}.md`
- `staging/nanoclaw-core/`, `staging/nanoclaw-trusted/`, `staging/nanoclaw-admin/`, `staging/nanoclaw-untrusted/`

For each staged item, determine which plugin it belongs to by consulting the `skill-tile-placement` skill: `Skill(skill: 'tessl__skill-tile-placement')`. When in doubt → **nanoclaw-admin**.

## Step 2: Promote staged content

Call `mcp__nanoclaw__promote_staging` for each plugin that has staged content:
- `mcp__nanoclaw__promote_staging(tileName: "nanoclaw-admin")` — if admin skills or rules are staged
- `mcp__nanoclaw__promote_staging(tileName: "nanoclaw-core")` — if core skills or rules are staged

If a specific skill was requested, pass `skillName` as well.

**Validate the result**: Check the return value of each `promote_staging` call for errors. If any call indicates failure, stop and report the error via `mcp__nanoclaw__send_message` before proceeding. Do **not** schedule the nuke or verify tasks if promotion failed.

## Step 3: Send promotion result

Send a message via `mcp__nanoclaw__send_message` with:
- What was promoted (skill names, plugin names, new plugin versions)
- Note that nuke fires in 20 min, verify in 21 min

## Step 4: Schedule nuke in 20 minutes

Compute `now + 20 minutes` as local time (NO Z suffix). Schedule:

```
mcp__nanoclaw__schedule_task(
  prompt: "Nuke this session to restart with fresh plugins: call mcp__nanoclaw__nuke_session()",
  schedule_type: "once",
  schedule_value: "<now+20min, format YYYY-MM-DDTHH:MM:SS, NO Z suffix>"
)
```

The 20-minute delay lets tessl's review+optimize pipeline finish before the container restarts.

## Step 5: Schedule verify-tiles in 21 minutes

Compute `now + 21 minutes` as local time (NO Z suffix). Schedule:

```
mcp__nanoclaw__schedule_task(
  prompt: "Run verify-tiles to confirm tile installation: Skill(skill: 'tessl__verify-tiles')",
  schedule_type: "once",
  schedule_value: "<now+21min, format YYYY-MM-DDTHH:MM:SS, NO Z suffix>"
)
```

The 1-minute gap after the nuke ensures the fresh container is ready before verify runs.
