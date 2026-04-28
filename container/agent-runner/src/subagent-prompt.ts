/**
 * Pure helpers for assembling the subagent prompt. Subagents don't
 * inherit `settingSources` from the parent — they only see what's in
 * their explicit `prompt` + `skills` array — so the agent-runner has
 * to enumerate every rule/behavior file by hand and read it in.
 *
 * The host CLAUDE.md is a thin trust-tier pointer post-#153 that
 * `@import`s its real targets; this loader does NOT resolve `@import`,
 * so the targets must be enumerated directly. Branching on `isMain`
 * is required because main's thin CLAUDE.md @-imports a different
 * rules path (project-root `.tessl/RULES.md`) and `groups/main/ADMIN.md`
 * for the admin runbook — these are not in the standard chain and
 * would silently disappear from main subagents without an explicit
 * branch (caught in PR #164 review).
 */

export interface SubagentRuleFilePathsInput {
  isMain: boolean;
  soulMdPath: string;
  formattingMdPath: string;
}

export function buildSubagentRuleFilePaths(
  input: SubagentRuleFilePathsInput,
): string[] {
  const files = [
    input.soulMdPath,
    input.formattingMdPath,
    '/workspace/group/MEMORY.md',
    '/workspace/group/.tessl/RULES.md',
  ];
  if (input.isMain) {
    files.push(
      '/workspace/project/.tessl/RULES.md',
      '/workspace/project/groups/main/ADMIN.md',
    );
  }
  return files;
}
