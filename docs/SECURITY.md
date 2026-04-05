# NanoClaw Security Model

## Three-Tier Trust Model

| Trust Level | Who gets it | Capabilities |
|-------------|-------------|-------------|
| **Main** (isMain: true) | Admin control group | Full DB, writable group folder, all tiles, all credentials, group management |
| **Trusted** (containerConfig.trusted: true) | Personal/friends groups | Full DB (read-only), writable group folder, core+trusted tiles, limited credentials |
| **Untrusted** (default) | Public/external groups | Filtered DB (own chat only), read-only group folder, core+untrusted tiles, no credentials |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in Docker containers with:
- **Process isolation** — container processes cannot affect the host
- **Filesystem isolation** — only explicitly mounted directories are visible
- **Non-root execution** — runs as unprivileged user (HOST_UID)
- **Ephemeral containers** — fresh environment per invocation (`--rm`)

Untrusted containers additionally get:
- **Read-only root filesystem** (`--read-only`) — prevents writing anywhere except tmpfs and bind mounts
- **tmpfs /tmp** (64MB) — only writable non-mount path
- **Resource limits** — 512MB RAM, 1 CPU, 256 PIDs, 5-minute timeout
- **No swap** — prevents disk-based memory expansion

### 2. Data Isolation

**Per-chat database isolation:**
Untrusted containers receive a filtered SQLite copy containing only their own group's messages. Trusted/main get the full database. The filtered copy is created at spawn time using `ATTACH DATABASE` — picks up schema changes automatically.

**Mount restrictions by trust level:**

| Path | Main | Trusted | Untrusted |
|------|------|---------|-----------|
| `/workspace/group` | read-write | read-write | **read-only** |
| `/workspace/global` | full directory | full directory (ro) | **SOUL-untrusted.md only** |
| `/workspace/trusted` | read-write | read-write | **not mounted** |
| `/workspace/store` | full DB (ro) | full DB (ro) | **filtered DB (ro)** |
| `/workspace/ipc` | full (rw) | full (rw) | **split: messages/ rw, input/ ro, no tasks/** |

### 3. IPC Security

IPC directories are per-group (isolated namespaces). For untrusted containers, IPC is split into separate mounts:
- `messages/` — writable (agent can send replies)
- `input/` — read-only (host sends follow-up messages)
- `tasks/` — **not mounted** (untrusted can't schedule tasks)
- Root IPC files (`available_groups.json`, `current_tasks.json`) — **not written** for untrusted

### 4. Credential Isolation

Credentials are managed by the host credential proxy — containers never see real API keys:

| Credential | Main | Trusted | Untrusted |
|------------|------|---------|-----------|
| Anthropic API | Via proxy (placeholder key) | Via proxy | Via proxy |
| Composio (Gmail, Calendar, etc.) | Environment variable | Environment variable | **None** |
| Other (GitHub, etc.) | Via host scripts | Via host scripts | **None** |

### 5. Tile-Based Rule Enforcement

Security rules are delivered via tessl tiles. Different trust levels get different tiles:

| Tile | Loaded for | Purpose |
|------|-----------|---------|
| `nanoclaw-core` | All containers | Basic behavior, formatting, silence, context recovery |
| `nanoclaw-trusted` | Trusted + main | Memory system, operational rules, proactive participation |
| `nanoclaw-admin` | Main only | External APIs, group management, scheduling, promotion |
| `nanoclaw-untrusted` | Untrusted only | Code execution refusal, credential protection, bad actor disengage |

Tile load order: core → trusted → admin. Admin loads last to override shared skills.

### 6. Identity Isolation

- **Main/Trusted**: Full SOUL.md with owner identity, personality, key people
- **Untrusted**: SOUL-untrusted.md (sanitized public identity) mounted as SOUL.md
- **CLAUDE.md**: Untrusted gets a dedicated template with trust-level warning as first line

### 7. Session Management

- Sessions invalidated after tile updates (promote_staging clears all sessions)
- `deploy.sh` kills ALL agent containers and clears staging overrides
- Stale staging skills trigger a warning log on every container spawn

## Memory System

Trusted containers have a shared memory system at `/workspace/trusted/`:

- **Typed memory files** with YAML frontmatter (user/feedback/project/reference)
- **MEMORY.md index** — max 200 lines, loaded at session bootstrap
- **Session bootstrap rule** — checks `/tmp` sentinel, triggers memory load on new sessions
- **Daily log dedup** — Jaccard similarity script (threshold 0.6) prevents duplicate entries
- **Importance-based decay** — permanent facts → typed files, medium-term → weekly, short-term → dropped

Untrusted containers have NO access to the memory system.

## Deployment

Single-command deploy via `scripts/deploy.sh`:
1. Pull latest code
2. Rebuild orchestrator
3. Update tiles from registry
4. **Clear staging overrides** from all groups
5. **Kill ALL agent containers** (forces fresh tile load)
6. Clear all sessions
7. Restart orchestrator

## Privilege Comparison

| Capability | Main | Trusted | Untrusted |
|------------|------|---------|-----------|
| Root filesystem | writable | writable | **read-only** |
| Group folder | read-write | read-write | **read-only** |
| Message database | full (rw) | full (ro) | **own chat only (ro)** |
| Global memory | full dir (rw) | full dir (ro) | **SOUL-untrusted.md only** |
| Shared trusted dir | read-write | read-write | **not mounted** |
| IPC tasks | full | full | **not mounted** |
| Schedule tasks | yes | yes | **no** |
| External credentials | all | limited | **none** |
| Auto-memory | enabled | enabled | **disabled** |
| Resource limits | none | none | **512MB/1CPU/256PIDs/5min** |
| Tiles | core+trusted+admin | core+trusted | **core+untrusted** |
| Memory system | full | full | **none** |
| Browser (agent-browser) | yes | yes | **yes** (for fact-checking) |
