<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

# NanoClaw — Baruch's Fork

A heavily customized fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) with three-tier security, typed memory system, and production deployment infrastructure. This is a real personal assistant running 24/7 on a NAS, managing Telegram groups with different trust levels.

**Upstream:** [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) — the original project

## What This Fork Adds

### Three-Tier Container Security

Every chat group runs in its own Docker container. Trust level determines what the container can see:

| | Main | Trusted | Untrusted |
|--|------|---------|-----------|
| Message DB | full (rw) | full (ro) | **own chat only** |
| Filesystem | writable | writable | **read-only** |
| Root filesystem | writable | writable | **immutable** (`--read-only`) |
| IPC | full | full | **messages only** |
| Credentials | all | limited | **none** |
| Memory system | full | full | **none** |
| Resource limits | none | none | **512MB/1CPU/5min** |

**Born from a real incident:** An untrusted group was exploited — the bot leaked internal files, full message history, and received an executable payload. Every security measure here closes a vector from that incident.

See [docs/SECURITY.md](docs/SECURITY.md) for the full model.

### Typed Memory System

Persistent memory across sessions using typed files with YAML frontmatter:

```
/workspace/trusted/
  MEMORY.md              # Index (200 lines max)
  user_profile.md        # type: user
  feedback_no-yapping.md # type: feedback (rule + why + how to apply)
  project_deploy.md      # type: project (absolute dates)
  reference_linear.md    # type: reference
```

- **Session bootstrap rule** — loads memory on every new session via `/tmp` sentinel
- **Jaccard dedup script** — deterministic duplicate detection before nightly archival
- **Importance-based decay** — permanent facts → typed files, medium-term → weekly, short-term → dropped
- **Memory verification** — memories are hints, treat as stale until verified

### Production Deployment

Single-command deploy for a NAS/Docker setup:

```bash
ssh nas "cd ~/nanoclaw && ./scripts/deploy.sh"
```

Does everything: pull, build orchestrator, update tiles, clear staging overrides, kill all agent containers, clear sessions, restart. No manual steps, no stale tiles.

### Tile-Based Rule System

Skills and rules delivered via [tessl](https://tessl.io) tiles with trust-based allocation:

| Tile | Loaded for | Examples |
|------|-----------|---------|
| `nanoclaw-core` | All containers | Silence rules, context recovery, ground truth |
| `nanoclaw-trusted` | Trusted + main | Memory bootstrap, system health, trusted behavior |
| `nanoclaw-admin` | Main only | Email, calendar, CFPs, heartbeat, group management |
| `nanoclaw-untrusted` | Untrusted only | Security rules, bad actor disengage |

### Unanswered Message Detection

Bot replies are tracked via `reply_to_message_id`. A deterministic script detects messages the bot acknowledged (reacted to) but never actually replied to — common after container nukes mid-conversation.

### Other Improvements

- **Reply context** — quoted messages passed to agent for conversation threading
- **Default silence** — comprehensive forbidden phrase list from real leaked patterns
- **Bad actor disengage** — total silence after detecting adversarial behavior
- **Staging override warnings** — logs when stale development copies shadow tile updates

## Setup

This fork is designed for NAS deployment with Docker. See upstream's [Quick Start](https://github.com/qwibitai/nanoclaw#quick-start) for initial setup, then:

1. Create your `SOUL.md` and `SOUL-untrusted.md` in `groups/global/`
2. Configure trust levels when registering groups (`containerConfig.trusted: true`)
3. Deploy: `./scripts/deploy.sh`

## Keeping Up with Upstream

```bash
claude
/update-nanoclaw
```

The `/update-nanoclaw` skill handles merge conflicts, previews changes, and validates the build.

## Contributing

Improvements to the security model, memory system, and deployment infrastructure are welcome as PRs. Personal skills (email, calendar, specific integrations) belong in your own fork.

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
