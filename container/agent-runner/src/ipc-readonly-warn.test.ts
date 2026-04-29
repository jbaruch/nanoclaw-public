import { describe, it, expect, vi } from 'vitest';

import { createReadonlyWarner } from './ipc-readonly-warn.js';

describe('createReadonlyWarner (#287 EROFS visibility)', () => {
  it('emits a warning on the first occurrence of an errno', () => {
    const log = vi.fn();
    const w = createReadonlyWarner(log);

    w.warn('EROFS', '1700000000-abcd.json');

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toMatch(/errno=EROFS/);
    expect(line).toMatch(/1700000000-abcd\.json/);
    expect(line).toMatch(/host-side sweep/);
  });

  it('suppresses repeat occurrences of the same errno (no log spam at poll cadence)', () => {
    const log = vi.fn();
    const w = createReadonlyWarner(log);

    w.warn('EROFS', 'first.json');
    w.warn('EROFS', 'second.json');
    w.warn('EROFS', 'third.json');

    // Only the first call must log — subsequent ones are silent so
    // the agent-runner's between-query IPC poll (`waitForIpcMessage`,
    // which calls `drainIpcInput` on every IPC_POLL_MS tick) doesn't
    // bury the rest of the log stream over the lifetime of the
    // container. During an in-flight query, only the close sentinel
    // is polled, but across many queries the cumulative count of
    // poll-and-fail can still be high without suppression.
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('warns once per distinct errno code', () => {
    const log = vi.fn();
    const w = createReadonlyWarner(log);

    // EROFS and EACCES are both legitimate read-only-mount codes — both
    // get one warning each so an operator sees the actual error class
    // hitting them, not just the first one that happened to fire.
    w.warn('EROFS', 'a.json');
    w.warn('EACCES', 'b.json');
    w.warn('EROFS', 'c.json');
    w.warn('EACCES', 'd.json');

    expect(log).toHaveBeenCalledTimes(2);
    expect((log.mock.calls[0][0] as string).includes('EROFS')).toBe(true);
    expect((log.mock.calls[1][0] as string).includes('EACCES')).toBe(true);
  });

  it('separate warner instances have independent state', () => {
    // Tests must not bleed state across other tests via module-level
    // singletons. Each test that wants its own clean slate creates a
    // fresh warner — verify that does what it says.
    const logA = vi.fn();
    const logB = vi.fn();
    const a = createReadonlyWarner(logA);
    const b = createReadonlyWarner(logB);

    a.warn('EROFS', 'a.json');
    a.warn('EROFS', 'a.json');
    b.warn('EROFS', 'b.json');

    expect(logA).toHaveBeenCalledTimes(1);
    expect(logB).toHaveBeenCalledTimes(1);
  });
});
