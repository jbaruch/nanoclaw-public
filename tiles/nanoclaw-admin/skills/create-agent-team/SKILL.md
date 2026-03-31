---
name: create-agent-team
description: Create a multi-agent team where each member posts to the group as a distinct identity. Use when the user asks for a panel, debate, research team, or any task involving multiple named agents working in parallel. Covers team setup, sender identity, message brevity rules, and lead-agent coordination.
---

# Create Agent Team

## CRITICAL: Follow the user's prompt exactly

Create *exactly* the team the user asked for — same number of agents, same roles, same names. Do NOT add extra agents, rename roles, or use generic names like "Researcher 1".

## Workflow sequence

Follow these steps in order:

1. *Create agents* — spin up each team member with the instructions below, matching the user's requested roles and names exactly.
2. *Verify sender identity* — after creating each agent, confirm they can successfully send a test message via `mcp__nanoclaw__send_message` with the correct `sender` parameter before assigning any tasks.
3. *Begin coordination* — once all agents are verified, assign tasks and begin lead-agent coordination and synthesis.

## Team member instructions

Each team member MUST be instructed to:

1. *Share progress in the group* via `mcp__nanoclaw__send_message` with a `sender` parameter matching their exact role/character name. Use the same name consistently so the bot identity stays stable.
2. *Coordinate with teammates* via `SendMessage` as normal.
3. Keep group messages *short* — 2-4 sentences max per message. Break longer content into multiple `send_message` calls.
4. NEVER use markdown formatting. Use ONLY WhatsApp/Telegram formatting: single *asterisks* for bold (NOT **double**), _underscores_ for italic, • for bullets, ```backticks``` for code. No ## headings, no `[links](url)`, no **double asterisks**.

Use a prompt like this when creating each teammate, substituting their actual name and role:

```
You are the Marine Biologist. Share findings with the group via mcp__nanoclaw__send_message with sender set to "Marine Biologist". Keep messages 2-4 sentences max, use Telegram formatting only (no markdown). Coordinate with teammates via SendMessage.
```

## Lead agent behavior

As the lead agent who created the team:

- You do NOT need to react to or relay every teammate message. The user sees those directly from the teammate bots.
- Send your own messages only to comment, share thoughts, synthesize, or direct the team.
- When processing an internal update from a teammate that doesn't need a user-facing response, wrap your *entire* output in `<internal>` tags.
- Focus on high-level coordination and the final synthesis.
