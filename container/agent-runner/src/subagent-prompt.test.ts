import { describe, it, expect } from 'vitest';

import { buildSubagentRuleFilePaths } from './subagent-prompt.js';

const SOUL = '/workspace/global/SOUL.md';
const FORMATTING = '/workspace/global/FORMATTING.md';

describe('buildSubagentRuleFilePaths', () => {
  it('non-main subagents get SOUL + FORMATTING + per-group MEMORY + per-group rules', () => {
    const files = buildSubagentRuleFilePaths({
      isMain: false,
      soulMdPath: SOUL,
      formattingMdPath: FORMATTING,
    });
    expect(files).toEqual([
      SOUL,
      FORMATTING,
      '/workspace/group/MEMORY.md',
      '/workspace/group/.tessl/RULES.md',
    ]);
  });

  it('main subagents additionally load project-root RULES + ADMIN.md', () => {
    const files = buildSubagentRuleFilePaths({
      isMain: true,
      soulMdPath: SOUL,
      formattingMdPath: FORMATTING,
    });
    // Both project-root paths must be present — the per-group
    // tessl path lives elsewhere on main and ADMIN.md carries the
    // admin/runbook instructions main subagents need.
    expect(files).toContain('/workspace/project/.tessl/RULES.md');
    expect(files).toContain('/workspace/project/groups/main/ADMIN.md');
    // And main still gets the standard chain (SOUL + FORMATTING + MEMORY +
    // per-group RULES) — the main-only files are additive, not replacements.
    expect(files).toContain(SOUL);
    expect(files).toContain(FORMATTING);
    expect(files).toContain('/workspace/group/MEMORY.md');
    expect(files).toContain('/workspace/group/.tessl/RULES.md');
  });

  it('main-only paths are NOT included when isMain is false', () => {
    const files = buildSubagentRuleFilePaths({
      isMain: false,
      soulMdPath: SOUL,
      formattingMdPath: FORMATTING,
    });
    expect(files).not.toContain('/workspace/project/.tessl/RULES.md');
    expect(files).not.toContain('/workspace/project/groups/main/ADMIN.md');
  });
});
