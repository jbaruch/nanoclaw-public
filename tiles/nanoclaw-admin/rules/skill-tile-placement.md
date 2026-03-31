# Skill Tile Placement Rule

When promoting a skill, always choose the correct tile based on who needs the skill:

## Decision checklist — run through in order

1. **Does this skill require Composio, Google APIs, or any external credentials?** → **nanoclaw-admin**
2. **Does this skill call `run_host_script`, `promote_staging`, or manage NanoClaw infrastructure?** → **nanoclaw-admin**
3. **Is this skill only meaningful in the main channel?** → **nanoclaw-admin**
4. **Could an untrusted container legitimately need this skill with no external API calls?** → **nanoclaw-core**

If in doubt: **admin**. Putting something in core that belongs in admin breaks the security model. The reverse is harmless.

## nanoclaw-admin
Skills that require elevated privileges, external APIs, or are main-channel-only:
- `verify-tiles` — tile management, requires promote_staging MCP tool
- `manage-groups` — group registration and configuration
- `morning-brief` — personal daily briefing (main channel only)
- `nightly-housekeeping` — maintenance tasks requiring host scripts
- `soul-review` — personal profile review
- `check-calendar` — requires Google Calendar via Composio
- `check-email` — requires Gmail via Composio
- `check-travel-bookings` — requires TripIt/external travel APIs
- `check-cfps`, `check-orders`, `check-unanswered`, `heartbeat` — all use Composio or admin APIs
- Any skill that calls `run_host_script`, `promote_staging`, or manages NanoClaw infrastructure

## nanoclaw-core
Skills needed by **all containers** (main, trusted, untrusted) with **no external API dependencies**:
- `format-message` — formatting reference, pure text lookup, no external calls

## Rule of thumb
"Does this skill make any external API call (Composio, Google, GitHub, etc.)?" → **admin**, always.
"Is it pure logic/formatting that works with zero credentials?" → core.

**Never put admin-only skills in nanoclaw-core.** They'll be available to untrusted containers.

**Always check before calling promote_staging — wrong tile = security model broken.**
