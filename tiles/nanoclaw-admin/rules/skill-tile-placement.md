# Skill Plugin Placement Rule

When promoting a skill or rule, always choose the correct plugin:

## Decision checklist — run through in order

1. **Does it require Composio, Google APIs, or any external credentials?** → **nanoclaw-admin**
2. **Does it call named host operations, `promote_staging`, or manage NanoClaw infrastructure?** → **nanoclaw-admin**
3. **Is it only meaningful in the main channel?** → **nanoclaw-admin**
4. **Does it read/write `/workspace/trusted/` or manage shared memory?** → **nanoclaw-trusted**
5. **Is it operational behavior for trusted containers (verification, system health)?** → **nanoclaw-trusted**
6. **Could an untrusted container legitimately need it with no external API calls?** → **nanoclaw-core**
7. **Is it a security rule for untrusted containers?** → **nanoclaw-untrusted**

If in doubt: **admin**. Putting something in core that belongs in admin breaks the security model.

## Plugin summary

| Plugin | Who gets it | What goes here |
|------|------------|----------------|
| **nanoclaw-core** | All containers | Basic behavior, formatting, language, silence, staging process |
| **nanoclaw-trusted** | Trusted + main | Shared memory, operational discipline, system health, skill dependencies |
| **nanoclaw-admin** | Main only | Personal skills, external API integrations, group management, promotion |
| **nanoclaw-untrusted** | Untrusted only | Security rules, code execution refusal, identity etiquette |

## Rule of thumb

- External API call → **admin**
- Writes to `/workspace/trusted/` → **trusted**
- Pure logic, no credentials, all containers need it → **core**
- Security restriction for public groups → **untrusted**

**Always check before calling promote_staging — wrong plugin = security model broken.**

