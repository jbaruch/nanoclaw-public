# Staging Process

When creating new skills or rules, always stage them for promotion:

## Skills (runtime + staging)
- New skill: `/workspace/group/skills/{name}/SKILL.md`
- Patch to existing tile skill: `/workspace/group/skills/tessl__{name}/SKILL.md`

The promote script finds both, strips `tessl__` prefix, promotes to the tile.

## Rules (staging only — no runtime effect until promoted)
- `/workspace/group/staging/{tile-name}/{name}.md`
- Target tiles:
  - `nanoclaw-core` — shared behavior (all containers)
  - `nanoclaw-admin` — admin/operational (main channel only)
  - `nanoclaw-untrusted` — security rules (untrusted groups only)

## Important
- Staging copies are NOT deleted after promotion — kept as working copies
- Skills in `tessl__*/` take runtime precedence over tile versions immediately
- Rules in `staging/` have NO runtime effect until the host runs the promote script
- After promotion, run `/verify-tiles` to confirm and clean up
