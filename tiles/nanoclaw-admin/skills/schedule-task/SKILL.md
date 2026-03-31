---
name: schedule-task
description: Schedule a task with a pre-check script that prevents unnecessary agent wake-ups. Use when scheduling tasks that should only wake the agent if a condition is met (new PRs, website changes, API status checks). Also covers cross-group scheduling (requires target_group_jid) and frequent task guidance.
---

# Schedule Task with Scripts

Use this skill to schedule tasks that run a condition-checking script before deciding whether to wake the agent.

## Task Scripts

When scheduling tasks that check a condition before acting (new PRs, website changes, API status), use the `script` parameter. The script runs first — if there's nothing to do, you don't wake up.

### How it works

1. The script runs before the agent is woken; it must print `{ "wakeAgent": true/false, "data": {...} }` to stdout
2. If `wakeAgent: false` — nothing happens; if `wakeAgent: true` — the agent wakes with the script's `data` and the `prompt`

### Always test your script first

Before scheduling, run the script in your sandbox to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### Scheduling with the `script` parameter

Once the script is verified, pass it alongside the `prompt` in the scheduling call:

```
schedule_task(
  prompt="New open PRs were found. Please review the data and post a summary.",
  script="""node --input-type=module -e \"
    const r = await fetch('https://api.github.com/repos/owner/repo/pulls?state=open');
    const prs = await r.json();
    console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
  \"""",
  cron="0 9 * * *"
)
```

The `prompt` is only delivered to the agent when the script outputs `wakeAgent: true`. The script's `data` field is automatically included in the wake-up context.

> If a task requires judgment every time (daily briefings, reminders, reports), skip the script and use a regular prompt.

---

## Advanced: Cross-group scheduling

To schedule a task that fires in a different group, include `target_group_jid`:

```
schedule_task(
  prompt="Check for updates and report to this group.",
  script="...",
  cron="0 * * * *",
  target_group_jid="group-jid@example"
)
```

Use this when the agent that sets up the schedule lives in a different group than the one where the task should run.

---

## Advanced: Frequent task guidance

If a user wants tasks running more than ~2x daily and a script can't reduce agent wake-ups:

- Explain that each wake-up uses API credits and risks rate limits
- Suggest restructuring with a script that checks the condition first
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency
