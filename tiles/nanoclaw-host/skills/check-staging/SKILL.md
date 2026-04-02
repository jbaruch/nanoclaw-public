---
name: check-staging
description: List pending skills and rules on the NAS staging area. Shows what the agent has created or updated that hasn't been promoted to tiles yet. Use before running promote, or when the user asks what's on staging.
---

# Check Staging

Lists what's pending on the NAS staging area.

## Usage

```bash
./scripts/check-staging.sh
```

## Output

Shows two sections:

**Skills** — from `groups/{group}/skills/`:
- `{name} (new)` — new skill, not yet in any tile
- `{name} (override via tessl__{name})` — patch to an existing tile skill

**Rules** — from `groups/{group}/staging/{tile-name}/`:
- Listed by tile subdirectory (e.g., `nanoclaw-untrusted/internal-reasoning.md`)

Empty sections mean nothing pending for that type.

### Example Output

```
Skills:
  summarise-pr (new)
  code-review (override via tessl__code-review)

Rules:
  nanoclaw-untrusted/internal-reasoning.md
  nanoclaw-trusted/rate-limit-policy.md
```
