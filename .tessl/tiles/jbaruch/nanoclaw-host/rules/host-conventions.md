# Host Agent Conventions

Rules for the NanoClaw host agent (Claude Code on Mac).

## Always deploy with deploy.sh

Never run `docker compose up -d --build` directly. Always use `./scripts/deploy.sh` — it pulls code, rebuilds, runs `tessl update` to fetch latest tiles from the registry, clears overrides, kills stale containers, clears sessions, and restarts. Skipping this means the orchestrator runs without the latest published tiles.

## Registry is the delivery artifact

Tessl registry plugins are what gets delivered to containers. Git is the source, not the delivery mechanism. Never skip publishing — always run the full promote pipeline.

## Nuke means kill container

When asked to nuke a group: kill the running container only. Never delete registrations or group folders. The orchestrator respawns a fresh container on the next message.

## No error suppression

Never use `|| true`, `2>/dev/null`, empty `catch {}`, or any form of silent error swallowing in scripts. If something fails, it must fail visibly.

## Two reasoning agents, one codebase

There are two agents improving this system: the container agent (AyeAye) and the host agent (you). Both make useful updates asynchronously. Never assume you have the latest version of anything. Never assume the other agent's work is stale, redundant, or inferior without reading it.

## Always diff, always read, always reason

Before making ANY judgment about staging content:

1. **Diff** the staging version against the current plugin version
2. **Read** every change — not just the filenames
3. **Reason** about what the changes do: are they improvements? new features? bug fixes? different approaches to the same problem?
4. **Merge** improvements into the plugin version when the staging version is better in some aspects and the plugin version is better in others
5. **Only then** decide: promote as-is, merge and promote, or request changes

"Stale" means the diff is empty — literally zero changes. Everything else requires reasoning. A file with the same name may have significant improvements that the plugin version doesn't have.

```bash
ssh -n "$NAS_HOST" "cat <staging-path>" | diff - <local-tile-path>
```

Never declare content "already promoted" based on the filename or timestamp. Always check the content.

## No deferral, no laziness

You are a stateless service. There is no "later", no "another session", no "next time." Every session is the only session. When you see a problem, fix it now. When the user asks for something, do it now.

Forbidden patterns:
- "Let's handle that separately" — no. Handle it now.
- "That's a problem for another day" — you don't have days. Fix it.
- "We can do that later" — there is no later for you.
- "Low priority, leave it" — the user didn't ask you to prioritize. Do the work.
- "Nice-to-have" — if you identified it, it needs doing.

If a task is genuinely too large for the current context, say so explicitly with a concrete plan. Don't wave it away.

## Boyscout rule — host edition

You own the full stack: source code, tile repos, scripts, deployment, NAS, containers. If you find a problem anywhere — fix it. Don't say "that's AyeAye's skill to fix" or "the container agent should handle that." If you can fix it from here, fix it from here.

This applies to:
- Broken tile content you discover during promotion
- Stale references in skills you're reviewing
- Config drift between NAS and local
- Scripts that fail because of a path or permission issue
- Anything you can see and reach

The only exception: changes to SOUL.md, personal skills, and group memory — those are the owner's domain. Everything else is yours to fix.

## Never edit tile repos directly

Tile content flows through the staging → promote pipeline. Never push directly to tile repos (jbaruch/nanoclaw-{tile}) for "quick fixes." Instead:

1. Push the content to NAS staging: `staging/{tileName}/rules/{name}.md` or `staging/{tileName}/skills/{name}/SKILL.md`
2. Promote with `TILE_NAME={tileName} ./scripts/promote-from-host.sh`

This keeps all tile changes — whether from AyeAye or from you — flowing through the same pipeline. GHA handles review, lint, and publish. Direct pushes bypass review and risk version conflicts with smart-publish.

## Scripts use common.sh

All scripts in `scripts/` source `scripts/common.sh` for shared config (`NAS_HOST`, `NAS_PROJECT_DIR`, `nas()` helper). No hardcoded IPs or paths.
