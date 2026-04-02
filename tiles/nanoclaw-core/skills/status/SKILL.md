---
name: status
description: Quick read-only health check — session context, workspace mounts, tool availability, and task snapshot. Use when the user asks for system status, health check, diagnostics, system info, check environment, what tools are available, or runs /status.
---

# /status — System Status Check

Generate a quick read-only status report of the current agent environment.

**No access restrictions.** This skill works in any group.

## How to gather the information

Run the checks below and compile results into the report format.

### 1. Session context

```bash
echo "Timestamp: $(date)"
echo "Working dir: $(pwd)"
echo "Channel: main"
```

### 2. Container uptime

Read `container_started` from `/workspace/group/session-state.json`. Compute age:

```python
import json, datetime
state = json.load(open('/workspace/group/session-state.json'))
started = state.get('container_started')
if started:
    age = datetime.datetime.utcnow() - datetime.datetime.fromisoformat(started.replace('Z',''))
    days = age.days
    hours = age.seconds // 3600
    print(f"{days}d {hours}h (since {started})")
else:
    print("unknown")
```

### 3. Workspace and mount visibility

```bash
echo "=== Workspace ==="
ls /workspace/ 2>/dev/null
echo "=== Group folder ==="
ls /workspace/group/ 2>/dev/null | head -20
echo "=== Extra mounts ==="
ls /workspace/extra/ 2>/dev/null || echo "none"
echo "=== IPC ==="
ls /workspace/ipc/ 2>/dev/null
```

### 4. Tool availability and container utilities

Check each tool family and report **available** or **unavailable**:

```bash
# Core — file system and shell tools
echo "Read/Write/Bash: available"

# Web — browser and fetch tools
which agent-browser 2>/dev/null && echo "Web (agent-browser): available" || echo "Web (agent-browser): unavailable"

# Orchestration — sub-agent / task tools
ls /workspace/ipc/ 2>/dev/null && echo "Orchestration (IPC): available" || echo "Orchestration (IPC): unavailable"

# Container utilities
node --version 2>/dev/null
claude --version 2>/dev/null
```

Then call `mcp__nanoclaw__list_tasks` — if it returns without error, report **MCP: available** and use the result for the task snapshot (step 5); if it errors, report **MCP: unavailable**.

### 5. Task snapshot

Use the result from the `mcp__nanoclaw__list_tasks` call above.

If no tasks exist, report "No scheduled tasks."

## Report format

Present as a clean, readable message using Telegram HTML:

```
🔍 <b>NanoClaw Status</b>

<b>Session:</b>
• Channel: main
• Time: 2026-03-14 09:30 UTC
• Working dir: /workspace/group

<b>Container:</b>
• Uptime: Nd Hh (started YYYY-MM-DDTHH:MM:SSZ)
• agent-browser: ✓ / not installed
• Node: vXX.X.X
• Claude Code: vX.X.X

<b>Workspace:</b>
• Group folder: ✓ (N files)
• Extra mounts: none / N directories
• IPC: ✓ (messages, tasks, input)

<b>Tools:</b>
• Core: ✓  Web: ✓  Orchestration: ✓  MCP: ✓

<b>Scheduled Tasks:</b>
• N active tasks / No scheduled tasks
```

Adapt based on what you actually find. Keep it concise — this is a quick health check, not a deep diagnostic.

**See also:** `/capabilities` for a full list of installed skills and tools.
