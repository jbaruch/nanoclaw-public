import { describe, it, expect } from 'vitest';

import {
  REACT_FIRST_DEFAULT_EMOJI,
  ReactIpcWriter,
  ReactToMessageIpcPayload,
  decideReactFirst,
  runReactFirstHook,
} from './react-first.js';

const baseGate = {
  isScheduledTask: false,
  isSubagent: false,
  prompt: 'hey Andy, how are things?',
  assistantName: 'Andy',
};

describe('decideReactFirst', () => {
  it('reacts on a normal user-facing inbound', () => {
    expect(decideReactFirst(baseGate)).toEqual({ react: true });
  });

  it('skips when the submission is from a sub-agent', () => {
    expect(decideReactFirst({ ...baseGate, isSubagent: true })).toEqual({
      react: false,
      skippedBy: 'subagent',
    });
  });

  it('skips on a scheduled task', () => {
    expect(
      decideReactFirst({ ...baseGate, isScheduledTask: true }),
    ).toEqual({ react: false, skippedBy: 'scheduled-task' });
  });

  it('skips when the prompt is wrapped as [SCHEDULED TASK]', () => {
    expect(
      decideReactFirst({
        ...baseGate,
        prompt: '[SCHEDULED TASK]\n\nScript output:\n{...}\n\nInstructions:\n...',
      }),
    ).toEqual({ react: false, skippedBy: 'scheduled-task-prompt-wrap' });
  });

  it('skips when assistantName is missing', () => {
    expect(
      decideReactFirst({ ...baseGate, assistantName: undefined }),
    ).toEqual({ react: false, skippedBy: 'no-assistant-name' });
  });

  it('skips when assistantName is empty', () => {
    expect(
      decideReactFirst({ ...baseGate, assistantName: '' }),
    ).toEqual({ react: false, skippedBy: 'no-assistant-name' });
  });

  it('subagent gate beats scheduled-task gate', () => {
    expect(
      decideReactFirst({
        ...baseGate,
        isSubagent: true,
        isScheduledTask: true,
      }),
    ).toEqual({ react: false, skippedBy: 'subagent' });
  });

  it('scheduled-task gate beats prompt-wrap gate', () => {
    expect(
      decideReactFirst({
        ...baseGate,
        isScheduledTask: true,
        prompt: '[SCHEDULED TASK] x',
      }),
    ).toEqual({ react: false, skippedBy: 'scheduled-task' });
  });
});

describe('REACT_FIRST_DEFAULT_EMOJI', () => {
  it('is the eye emoji', () => {
    expect(REACT_FIRST_DEFAULT_EMOJI).toBe('👀');
  });
});

describe('runReactFirstHook', () => {
  const baseHookInput = {
    isScheduledTask: false,
    isSubagent: false,
    prompt: '<message id="msg_42" sender="Baruch">help me</message>',
    assistantName: 'Andy',
    chatJid: '120363042@g.us',
    groupFolder: 'main',
    sessionName: 'default',
  };
  const fixedNow = () => new Date('2026-04-27T18:00:00.000Z');

  function makeRecordingWriter(): {
    writer: ReactIpcWriter;
    payloads: ReactToMessageIpcPayload[];
  } {
    const payloads: ReactToMessageIpcPayload[] = [];
    return {
      writer: (p) => {
        payloads.push(p);
      },
      payloads,
    };
  }

  it('emits the default emoji on a normal user-facing inbound', () => {
    const { writer, payloads } = makeRecordingWriter();
    const result = runReactFirstHook(baseHookInput, writer, fixedNow);
    expect(result).toEqual({ kind: 'emitted', emoji: '👀' });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      type: 'react_to_message',
      chatJid: '120363042@g.us',
      groupFolder: 'main',
      sessionName: 'default',
      emoji: '👀',
      timestamp: '2026-04-27T18:00:00.000Z',
    });
  });

  it('skips with `subagent` reason without invoking the writer', () => {
    const { writer, payloads } = makeRecordingWriter();
    const result = runReactFirstHook(
      { ...baseHookInput, isSubagent: true },
      writer,
      fixedNow,
    );
    expect(result).toEqual({ kind: 'skipped', skipReason: 'subagent' });
    expect(payloads).toHaveLength(0);
  });

  it('skips with `scheduled-task` reason on isScheduledTask', () => {
    const { writer, payloads } = makeRecordingWriter();
    const result = runReactFirstHook(
      { ...baseHookInput, isScheduledTask: true },
      writer,
      fixedNow,
    );
    expect(result).toEqual({ kind: 'skipped', skipReason: 'scheduled-task' });
    expect(payloads).toHaveLength(0);
  });

  it('skips with `scheduled-task-prompt-wrap` reason on wrapped prompt', () => {
    const { writer, payloads } = makeRecordingWriter();
    const result = runReactFirstHook(
      {
        ...baseHookInput,
        prompt: '[SCHEDULED TASK] body',
      },
      writer,
      fixedNow,
    );
    expect(result).toEqual({
      kind: 'skipped',
      skipReason: 'scheduled-task-prompt-wrap',
    });
    expect(payloads).toHaveLength(0);
  });

  it('skips with `no-assistant-name` reason when assistantName is empty', () => {
    const { writer, payloads } = makeRecordingWriter();
    const result = runReactFirstHook(
      { ...baseHookInput, assistantName: '' },
      writer,
      fixedNow,
    );
    expect(result).toEqual({
      kind: 'skipped',
      skipReason: 'no-assistant-name',
    });
    expect(payloads).toHaveLength(0);
  });

  it('returns `ipc-failed` on an expected NodeJS.ErrnoException', () => {
    const writer: ReactIpcWriter = () => {
      const err = new Error('write EROFS') as NodeJS.ErrnoException;
      err.code = 'EROFS';
      throw err;
    };
    const result = runReactFirstHook(baseHookInput, writer, fixedNow);
    expect(result).toEqual({
      kind: 'ipc-failed',
      emoji: '👀',
      code: 'EROFS',
      message: 'write EROFS',
    });
  });

  it('returns `ipc-failed` on ENOSPC (disk full)', () => {
    const writer: ReactIpcWriter = () => {
      const err = new Error('no space left on device') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    };
    const result = runReactFirstHook(baseHookInput, writer, fixedNow);
    expect(result.kind).toBe('ipc-failed');
    if (result.kind === 'ipc-failed') {
      expect(result.code).toBe('ENOSPC');
    }
  });

  it('rethrows non-errno errors so programming bugs surface', () => {
    const writer: ReactIpcWriter = () => {
      throw new TypeError('bad payload shape');
    };
    expect(() => runReactFirstHook(baseHookInput, writer, fixedNow)).toThrow(
      TypeError,
    );
  });

  it('rethrows errno errors with codes outside the allow-list', () => {
    const writer: ReactIpcWriter = () => {
      const err = new Error('busy') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    };
    expect(() => runReactFirstHook(baseHookInput, writer, fixedNow)).toThrow();
  });

  it('builds payloads with the supplied chatJid / sessionName / groupFolder', () => {
    const { writer, payloads } = makeRecordingWriter();
    runReactFirstHook(
      {
        ...baseHookInput,
        chatJid: 'other@s.whatsapp.net',
        sessionName: 'maintenance',
        groupFolder: 'another-group',
      },
      writer,
      fixedNow,
    );
    expect(payloads[0].chatJid).toBe('other@s.whatsapp.net');
    expect(payloads[0].sessionName).toBe('maintenance');
    expect(payloads[0].groupFolder).toBe('another-group');
  });
});
