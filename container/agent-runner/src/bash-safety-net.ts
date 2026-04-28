/**
 * bash-safety-net — pure deny logic for the `Bash` PreToolUse hook (#143).
 *
 * Every pattern below has produced or could produce a non-recoverable
 * incident inside an agent container: filesystem wipe, force-push to
 * `main`, raw-disk overwrite, fork bomb. Text rules tell the agent not
 * to run them; this hook removes the option. The handler in `index.ts`
 * runs `evaluateBashCommand` against the `tool_input.command` string
 * and returns a `deny` permission decision when it matches.
 *
 * Kept SDK-free so the root vitest can exercise it without spinning up
 * `@anthropic-ai/claude-agent-sdk`.
 */

export interface BashSafetyDecision {
  deny: boolean;
  /** Short, agent-readable explanation when `deny === true`. */
  reason?: string;
  /** Identifier of the matched rule, surfaced to logs for triage. */
  matched?: string;
}

interface BashRule {
  id: string;
  /** Regex tested against the literal `command` string. */
  pattern: RegExp;
  /** Hint shown to the agent when this rule fires. */
  reason: string;
}

/**
 * Curated catalogue of always-deny patterns. Each rule explains what
 * blast radius it forecloses on. Keep this list tight — false positives
 * here get the agent stuck mid-task.
 *
 * Patterns target the *literal* command string the SDK passes through,
 * not a parsed shell AST: agents under load reach for the obvious form
 * of each operation, and matching the obvious form is sufficient. Real
 * adversaries are out of scope; this is a guard against the model
 * rationalising a destructive command on itself.
 */
const RULES: BashRule[] = [
  {
    id: 'rm-rf-root',
    // `rm -rf /` and the protected mount roots inside the container.
    // Match anywhere in the command so chained forms (`cd /tmp; rm -rf /`)
    // still trip.
    //
    // Flag shapes the regex covers:
    //  - Combined flags in any order (`-rf`, `-fr`, `-Rf`, `-rfv`).
    //  - Split flags (`-r -f`, `-f -r`, `-R -f`, etc.).
    //  - Long flags (`--recursive --force` / `--force --recursive`).
    //  - End-of-options marker (`rm -rf -- /`).
    //
    // Path shapes the regex covers (each anchored with the trailing
    // boundary `(?=\s|$|;|&)` so `/workspace/foo` and similar deeper
    // paths are NOT caught):
    //  - Bare roots `/`, `~`, `$HOME`.
    //  - Trailing slash forms `/workspace/`, `~/`, `$HOME/`.
    //  - Trailing dot-segment forms `/workspace/.` and `/workspace/..`.
    //  - Per-user `/home/<name>` and `/home/<name>/`.
    pattern:
      /\brm\s+(?:(?:-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*)(?:\s+-[a-zA-Z]+)*|(?:-[rR]\s+-[fF]|-[fF]\s+-[rR])(?:\s+-[a-zA-Z]+)*|--recursive\s+--force|--force\s+--recursive)(?:\s+--)?\s+(?:\/(?=\s|$|;|&)|\/workspace(?:\/(?:\.{0,2})?)?(?=\s|$|;|&)|~\/?(?=\s|$|;|&)|\$HOME\/?(?=\s|$|;|&)|\/home\/[a-zA-Z0-9_.-]+\/?(?=\s|$|;|&))/,
    reason:
      'rm -rf on a root-level / mount-root path is denied. Scope the delete to a subtree (e.g. ./build, node_modules, staging/<name>).',
  },
  {
    id: 'force-push-main',
    // git push targeted at main/master forced via either:
    //  - `--force` / `--force-with-lease` / `-f` flag, OR
    //  - `+refspec` syntax (leading `+` makes the push fast-forward-
    //    bypassing — equivalent to `--force`).
    //
    // Both shapes match only when the destination ref is `main` or
    // `master`, so feature-branch rebases (legitimate) are unaffected.
    pattern:
      /\bgit\s+push\s+(?:(?:[^\n;]*\s)?(?:-f\b|--force(?:-with-lease)?\b)[^\n;]*\b(?:HEAD:)?(?:main|master)\b|(?:[^\n;]*\s)\+(?:HEAD:)?(?:main|master)\b)/,
    reason:
      'git push --force (or `+refspec`) to main/master is denied. Force-push only feature branches; for main, fix forward.',
  },
  {
    id: 'mkfs',
    // Filesystem creation on any device. Anchored to a command-start
    // position — start of string, after `;`, `&`, `&&`, `|`, `||`, or
    // inside a `$(...)`/backtick subshell — so prose mentions like
    // `echo mkfs.ext4 docs.md` or `grep mkfs README` aren't flagged.
    // Trailing space requirement keeps `$mkfs_var` benign too.
    pattern: /(?:^|[;&|]+\s*|`\s*|\$\(\s*)mkfs(?:\.[a-zA-Z0-9_-]+)?\s/,
    reason:
      'mkfs.* is denied — formatting a filesystem from inside a container is never the right answer.',
  },
  {
    id: 'dd-to-disk',
    // dd with of=/dev/sd*, /dev/nvme*, /dev/disk*. Catches `dd if=foo
    // of=/dev/sda`. Doesn't gate dd to regular files.
    pattern: /\bdd\b[^\n;]*\bof=\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+|disk\d+|hd[a-z]\d*)/,
    reason:
      'dd of=/dev/sd* (raw disk write) is denied. Use a path under /tmp or /workspace if you need to stage a file.',
  },
  {
    id: 'redirect-to-disk',
    // Shell redirect to a raw block device.
    pattern: />\s*\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+|disk\d+|hd[a-z]\d*)\b/,
    reason:
      'Redirect to /dev/sd* (raw block device) is denied. Pick a regular file path.',
  },
  {
    id: 'chmod-recursive-777',
    // chmod -R 777 anywhere — the textbook permission-loosening
    // mistake on shared mounts. Same command-start anchoring as
    // `mkfs` so `echo "chmod -R 777"` in prose isn't flagged.
    pattern: /(?:^|[;&|]+\s*|`\s*|\$\(\s*)chmod\s+(?:-R\s+|--recursive\s+|-[a-zA-Z]*R[a-zA-Z]*\s+)0?777\b/,
    reason:
      'chmod -R 777 is denied — opens shared mounts to every uid in the container. Scope permissions per file/dir.',
  },
  {
    id: 'chown-recursive-mount-root',
    // chown -R aimed at a shared mount root or container root. Same
    // command-start anchoring as the rules above.
    pattern:
      /(?:^|[;&|]+\s*|`\s*|\$\(\s*)chown\s+(?:-R\s+|--recursive\s+|-[a-zA-Z]*R[a-zA-Z]*\s+)\S+\s+(?:\/|\/workspace|\/workspace\/group|~|\$HOME)(?:\s|$|;|&)/,
    reason:
      'chown -R on a mount root is denied — re-owning shared state breaks the orchestrator + every other container.',
  },
  {
    id: 'fork-bomb',
    // Classic POSIX fork bomb shapes. The canonical `:(){ :|: & };:`
    // and the named-function variant. Whitespace inside the function
    // body is variable, so match the load-bearing tokens.
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: 'Fork bomb pattern denied.',
  },
];

/**
 * Decide whether the given Bash `command` string should be blocked.
 *
 * `tool_input` is `unknown` per the SDK type, so the caller in `index.ts`
 * is responsible for the narrowing. We accept just the string here so
 * the helper stays SDK-free and trivially testable.
 *
 * Empty / non-string commands return `{ deny: false }` — non-decision.
 * The TaskOutput-block gate uses the same shape, so the calling hook
 * code is symmetric across both.
 */
export function evaluateBashCommand(command: unknown): BashSafetyDecision {
  if (typeof command !== 'string' || command.length === 0) {
    return { deny: false };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(command)) {
      return {
        deny: true,
        matched: rule.id,
        reason: rule.reason,
      };
    }
  }
  return { deny: false };
}

/**
 * Exposed only so the unit tests can iterate the catalogue. Runtime
 * code goes through `evaluateBashCommand`.
 */
export const BASH_SAFETY_RULE_IDS = RULES.map((r) => r.id);
