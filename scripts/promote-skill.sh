#!/usr/bin/env bash
# Promote the agent-created skills and rules from NAS staging to tessl tiles.
#
# Usage:
#   ./scripts/promote-skill.sh                    # promote ALL staging skills + rules
#   ./scripts/promote-skill.sh skill-name         # promote one skill
#   ./scripts/promote-skill.sh --rules-only       # promote only rules
#
# Flow:
#   1. Pull skills/rules from NAS staging
#   2. Copy to tiles/
#   3. Run tessl skill review --optimize on each
#   4. Update tile.json
#   5. Lint
#   6. Commit, push, publish, deploy
#   7. Version bump commit
#
# Staging copies are NOT deleted — the agent keeps them as working copies.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
GROUP_FOLDER="${GROUP_FOLDER:-<GROUP_FOLDER>}"
TILE_NAME="${TILE_NAME:-nanoclaw-core}"

TILE_DIR="$PROJECT_ROOT/tiles/$TILE_NAME"
TILE_JSON="$TILE_DIR/tile.json"

if [ ! -f "$TILE_JSON" ]; then
  echo "Error: $TILE_JSON not found"
  exit 1
fi

# --- Helpers ---

pull_skill() {
  local name="$1"
  local skills_base="$NAS_PROJECT_DIR/groups/$GROUP_FOLDER/skills"
  local dst="$TILE_DIR/skills/$name"

  # Try skills/{name} first, then skills/tessl__{name} (runtime override path)
  local src="$skills_base/$name"
  if ! nas "test -d '$src'"; then
    src="$skills_base/tessl__$name"
    if ! nas "test -d '$src'"; then
      echo "  ERROR: $name not found in skills/ or skills/tessl__$name on NAS"
      return 1
    fi
  fi

  mkdir -p "$dst"
  nas "tar czf - -C $src ." | tar xzf - -C "$dst"
  if [ ! -f "$dst/SKILL.md" ]; then
    echo "  ERROR: $name/SKILL.md not found on NAS"
    rm -rf "$dst"
    return 1
  fi
  echo "  pulled: $name (from $(basename $src))"
}

pull_rule() {
  local name="$1"
  local src="$NAS_PROJECT_DIR/groups/$GROUP_FOLDER/staging/$TILE_NAME/$name.md"
  local dst="$TILE_DIR/rules/$name.md"
  mkdir -p "$TILE_DIR/rules"
  nas "cat $src" > "$dst"
  if [ ! -s "$dst" ]; then
    echo "  ERROR: $name.md not found or empty on NAS"
    rm -f "$dst"
    return 1
  fi
  echo "  pulled: $name"
}

optimize_skill() {
  local path="$1"
  local name=$(basename "$(dirname "$path")")
  tessl skill review --optimize --yes --max-iterations 3 "$path" 2>&1 | grep -E "Score|No improvements|Changes applied" || echo "  ($name: tessl review skipped)"
}

add_to_tile_json() {
  local type="$1"  # "skills" or "rules"
  local name="$2"
  local path_key="$3"  # "path" for skills, "rules" for rules
  local path_val="$4"
  python3 -c "
import json
with open('$TILE_JSON') as f:
    tile = json.load(f)
section = tile.setdefault('$type', {})
if '$name' not in section:
    section['$name'] = {'$path_key': '$path_val'}
    print('  added: $name')
else:
    print('  exists: $name')
with open('$TILE_JSON', 'w') as f:
    json.dump(tile, f, indent=2)
    f.write('\n')
"
}

# --- Determine what to promote ---

MODE="${1:-all}"
SKILLS_TO_PROMOTE=()
PROMOTE_RULES=false

if [ "$MODE" = "--rules-only" ]; then
  PROMOTE_RULES=true
elif [ "$MODE" = "all" ] || [ "$MODE" = "--all" ]; then
  # Get all staging skills from NAS (both skills/{name} and skills/tessl__{name})
  declare -A SEEN_SKILLS
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # Strip tessl__ prefix to get the canonical skill name
    skill_name="${line#tessl__}"
    if [ -z "${SEEN_SKILLS[$skill_name]+x}" ]; then
      SEEN_SKILLS[$skill_name]=1
      SKILLS_TO_PROMOTE+=("$skill_name")
    fi
  done < <(nas "ls $NAS_PROJECT_DIR/groups/$GROUP_FOLDER/skills/")
  PROMOTE_RULES=true
else
  SKILLS_TO_PROMOTE=("$MODE")
fi

echo "=== Promote to $TILE_NAME ==="
echo ""

# --- 1. Pull from NAS ---

PROMOTED_COUNT=0

if [ ${#SKILLS_TO_PROMOTE[@]} -gt 0 ]; then
  echo "1. Pulling ${#SKILLS_TO_PROMOTE[@]} skill(s) from NAS..."
  for skill in "${SKILLS_TO_PROMOTE[@]}"; do
    [ -z "$skill" ] && continue
    if pull_skill "$skill"; then
      ((++PROMOTED_COUNT))
    fi
  done
  echo ""
fi

if [ "$PROMOTE_RULES" = true ]; then
  echo "1b. Pulling rules from NAS..."
  STAGING_DIR="$NAS_PROJECT_DIR/groups/$GROUP_FOLDER/staging/$TILE_NAME"
  RULES_ON_NAS=$(nas "if [ -d '$STAGING_DIR' ]; then for f in '$STAGING_DIR'/*.md; do [ -f \"\$f\" ] && basename \"\$f\" .md; done; fi")
  for rule in $RULES_ON_NAS; do
    [ -z "$rule" ] && continue
    if pull_rule "$rule"; then
      ((++PROMOTED_COUNT))
    fi
  done
  echo ""
fi

if [ "$PROMOTED_COUNT" -eq 0 ]; then
  echo "Nothing to promote."
  exit 0
fi

# --- 2. Optimize ---

echo "2. Running tessl skill review --optimize on promoted skills..."
for skill in "${SKILLS_TO_PROMOTE[@]}"; do
  [ -z "$skill" ] && continue
  skill_md="$TILE_DIR/skills/$skill/SKILL.md"
  [ -f "$skill_md" ] || continue
  optimize_skill "$skill_md"
done
echo ""

# --- 3. Update tile.json ---

echo "3. Updating tile.json..."
for skill_dir in "$TILE_DIR"/skills/*/; do
  [ -d "$skill_dir" ] || continue
  name=$(basename "$skill_dir")
  add_to_tile_json "skills" "$name" "path" "skills/$name/SKILL.md"
done
for rule_file in "$TILE_DIR"/rules/*.md; do
  [ -f "$rule_file" ] || continue
  name=$(basename "$rule_file" .md)
  add_to_tile_json "rules" "$name" "rules" "rules/$name.md"
done
echo ""

# --- 4. Lint ---

echo "4. Linting..."
tessl tile lint "$TILE_DIR"
echo ""

# --- 5. Commit, push, publish, deploy ---

echo "=== Ready to ship ==="
echo ""
read -p "Commit, push, publish, and deploy? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Stopped. Changes are in tiles/ — commit manually when ready."
  exit 0
fi

cd "$PROJECT_ROOT"
git add "tiles/$TILE_NAME/"
git commit -m "feat: promote ${PROMOTED_COUNT} skill(s)/rule(s) from the agent staging

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push origin main

echo ""
echo "Deploying to NAS (tiles are delivered from git, not tessl registry)..."
nas "cd $NAS_PROJECT_DIR && git pull && docker compose up -d --build"

echo ""
echo "Publishing to tessl registry..."
if tessl tile publish --bump patch "$TILE_DIR"; then
  git add "$TILE_JSON"
  git commit -m "chore: bump $TILE_NAME version after publish

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
  git push origin main
  nas "cd $NAS_PROJECT_DIR && git pull"

  echo ""
  echo "Pulling tiles from registry into orchestrator..."
  # IMPORTANT: install ALL tiles together — vendored mode removes tiles not in the install list
  TILE_OWNER_VAL=$(grep TILE_OWNER "$PROJECT_ROOT/.env" 2>/dev/null | cut -d= -f2)
  TILE_OWNER_VAL="${TILE_OWNER_VAL:-nanoclaw}"
  ALL_TILES=$(ls "$PROJECT_ROOT/tiles/" | while read t; do echo "$TILE_OWNER_VAL/$t"; done | tr '\n' ' ')
  nas "docker exec nanoclaw sh -c 'cd /app/tessl-workspace && tessl install $ALL_TILES --yes --dangerously-ignore-security --agent claude-code 2>&1'" || {
    echo "  ERROR: tessl install in orchestrator failed"
    exit 1
  }
else
  echo "  tessl publish failed — tiles deployed via git only"
fi

echo ""
echo "Done! $PROMOTED_COUNT item(s) promoted and deployed."
echo "Tell the agent to run /verify-tiles to clean up staging copies."
