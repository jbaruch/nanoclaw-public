/**
 * Shared filesystem-error policy for best-effort writers and sweepers.
 *
 * Background: parts of the orchestrator do best-effort filesystem work
 * (writing IPC sentinels, sweeping stale inputs, etc.) and must NOT
 * block the message-delivery path on every transient errno. The policy
 * here is "tolerate codes that legitimately occur on the IPC dirs;
 * propagate everything else so a real bug (TypeError, ReferenceError,
 * unrelated programming error) surfaces instead of being silently
 * swallowed."
 *
 * Originally inlined in `src/group-queue.ts`; extracted here so writers
 * (group-queue) and sweepers (ipc-input-sweep) can't drift on which
 * errnos they treat as expected. If a new caller needs the same
 * policy, import from here rather than redefining the set.
 *
 * Codes covered:
 * - EACCES / EPERM — permission denied
 * - ENOSPC — disk full
 * - EROFS — read-only filesystem (e.g. failover read-only mount)
 * - ENOENT — input dir vanished mid-iteration
 * - EISDIR — path collision (a directory exists where the file would go)
 * - EBUSY — file in use by another writer
 * - ENOTDIR — a path component isn't a directory
 * - EMFILE / ENFILE — process / system fd table full
 * - ENAMETOOLONG — synthesised path exceeds the OS limit
 */
const EXPECTED_FS_ERROR_CODES = new Set([
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EROFS',
  'ENOENT',
  'EISDIR',
  'EBUSY',
  'ENOTDIR',
  'EMFILE',
  'ENFILE',
  'ENAMETOOLONG',
]);

/**
 * Returns true when `err` is an Error with a `.code` matching the
 * shared expected-errno set. Anything else (including non-Error values
 * thrown directly, e.g. strings or programming bugs) returns false so
 * the caller's `if (!isExpectedFsError(err)) throw err;` path fires.
 */
export function isExpectedFsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && EXPECTED_FS_ERROR_CODES.has(code);
}
