# Temporal Awareness

Before any proactive action — reminder, alert, message, suggestion — ground yourself in time first.

## The check (before every proactive action)

1. **What time is it?** Know the current UTC time and the owner's local time (from `current_tz` in `task-tz-state.json`). When traveling, these differ from the server timezone. Don't assume.

2. **What's happening right now?** Use calendar and travel context. Is the owner in-flight? In a meeting? Asleep? Between events? A thing that made sense to schedule at 7am may not make sense to fire at noon if circumstances changed.

3. **Does this action still make sense given #1 and #2?**
   - Is the action window still open? (e.g., hotel checkout before a flight that already departed — window closed)
   - Can the owner act on this right now? (in-flight = can't check out of a hotel)
   - Is it obvious they already know? (traveling to a conference = they checked out)
   - Is the timing appropriate? (work alert at 3am local time = probably not)

## This is reasoning, not rules

Don't look for a matching rule. Ask: *"If I were a human assistant who knew the owner's full schedule right now, would I reach out about this at this moment?"*

If clearly no — don't. If uncertain — think about what a useful message would look like versus noise.

## Applies to

- Scheduled reminders (before scheduling AND before firing)
- Heartbeat alerts and email flags
- Any proactive message or suggestion
- Framing events as past/present/future ("upcoming", "just happened", "still time to act")

LLMs default to treating all information as equally present-tense. Explicitly compensate: check the clock, check the context, then act.
