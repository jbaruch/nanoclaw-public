/**
 * One-shot warner for read-only IPC input mounts.
 *
 * Untrusted containers mount `/workspace/ipc/input` read-only by design
 * (issue #287). The agent-runner's `drainIpcInput()` reads files from
 * that dir and tries to unlink them; on the RO mount the unlink fails
 * with `EROFS` (or `EACCES` on some filesystems). The error is expected
 * and the host-side sweep is responsible for cleanup — but silently
 * swallowing it for two days is what hid the original IPC backlog bug
 * before it surfaced as an 800k-char auto-compact poisoning event.
 *
 * The fix: surface the FIRST occurrence of each errno code loudly so
 * the next regression of this class is visible at a glance in container
 * logs, then suppress further reports to avoid log spam at the IPC poll
 * cadence (the agent-runner's `IPC_POLL_MS`, currently 500ms, drains
 * the dir for the entire lifetime of the container).
 *
 * State is instance-scoped: each call to `createReadonlyWarner` gets
 * its own `Set<errno>` via closure, so each warner emits at most one
 * warning per code. Production code creates a single warner at module
 * load and uses it everywhere — that's where the "one warning per
 * process" guarantee actually comes from. Tests create fresh warners
 * to verify per-instance suppression independent of any other test.
 */
export type LogFn = (line: string) => void;

export interface ReadonlyWarner {
  /**
   * Report a read-only-mount errno. The first call for a given `code`
   * emits a warning via `log`; subsequent calls with the same `code`
   * are silent. The `file` is included only in the first warning.
   */
  warn(code: string, file: string): void;
}

export function createReadonlyWarner(log: LogFn): ReadonlyWarner {
  const announced = new Set<string>();
  return {
    warn(code: string, file: string): void {
      if (announced.has(code)) return;
      announced.add(code);
      log(
        `WARN drainIpcInput: cannot unlink IPC inputs (errno=${code}) — ` +
          `read-only mount; host-side sweep is responsible for cleanup ` +
          `(first hit on ${file}, suppressing further reports)`,
      );
    },
  };
}
