# Fork Setup — Three-Tier Upstream Chain

This repo is designed as the middle tier of a three-tier fork chain:

```
upstream (qwibitai/nanoclaw)     ← official NanoClaw
    ↓ merge
public (this repo)               ← your improvements, no personal data
    ↓ merge
private (your private fork)      ← personal config, credentials, group data
```

## Creating Your Private Fork

### 1. Create a private repo from this one

```bash
gh repo create your-org/nanoclaw --private
git clone https://github.com/your-org/nanoclaw.git my-nanoclaw
cd my-nanoclaw
git remote add public https://github.com/jbaruch/nanoclaw-public.git
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git pull public main
```

### 2. Set up merge=ours for personalized files

```bash
git config merge.ours.driver true
```

The `.gitattributes` in this repo marks these paths as `merge=ours`:
- `groups/global/SOUL.md` — your assistant's personality
- `groups/global/CLAUDE.md` — global agent instructions
- `groups/main/CLAUDE.md` — main channel instructions
- `tiles/nanoclaw-admin/**` — your personal admin skills

When you merge from public into private, these files always keep YOUR version.

### 3. Personalize

Replace the demo files with your own:

**`groups/global/SOUL.md`** — Your assistant's identity. Name, personality, communication style, key people, projects. The more specific, the more useful.

**`tiles/nanoclaw-admin/`** — Your personal skills. The demo tile ships with 5 generic skills. Add your own: morning briefs, email checks, calendar integration, whatever you need. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the skill format.

**`.env`** — Copy `.env.example`, fill in your credentials:
```bash
cp .env.example .env
# Edit .env with your API keys, bot tokens, etc.
```

Set `TILE_OWNER` to your tessl workspace name (for tile publishing).

### 4. Deploy

```bash
# Local development
npm install && npm run dev

# Docker (NAS/server)
# Edit docker-compose.yml: set HOST_PROJECT_ROOT, HOST_UID, HOST_GID
docker compose up -d --build

# First-time setup
# Run /setup in Claude Code
```

## Syncing Updates

### From upstream (official NanoClaw) into public

```bash
cd nanoclaw-public
git fetch upstream
git merge upstream/main
# Resolve conflicts (usually package.json, src/index.ts)
npm run build && npm test
git push origin main
```

### From public into private

```bash
cd my-nanoclaw
git fetch public
git merge public/main
# merge=ours keeps your SOUL.md, CLAUDE.md, admin tile
# Source code merges cleanly (identical after .env config)
npm run build && npm test
git push origin main
```

### Private improvements → public

When you build something generic (not personal):

1. Make the change in private
2. Cherry-pick or re-implement in public (ensure no personal data)
3. Push to public
4. Optionally PR to upstream

## What Goes Where

| Content | Public | Private |
|---------|--------|---------|
| Source code (src/, container/) | ✓ identical | ✓ identical |
| Core/untrusted/host tiles | ✓ identical | ✓ identical |
| Admin tile | demo skills | your personal skills |
| SOUL.md | demo persona | your persona |
| CLAUDE.md | generic template | your instructions |
| .env | .env.example | real credentials |
| Group folders | empty templates | conversation history |
| Scripts | identical | identical |
| Blog notes, research | — | ✓ private only |

## Key Design Decision

The source code is IDENTICAL between public and private forks. Every personal value comes from `.env` (TILE_OWNER, ASSISTANT_NAME, HOST_UID, etc.). This means:
- Zero merge conflicts on code files
- Only 4 paths need merge=ours (personality + admin tile)
- Bug fixes flow cleanly in both directions
