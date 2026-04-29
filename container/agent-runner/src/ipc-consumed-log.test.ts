import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { drainIpcInputAt, loadConsumedInputs } from './index.js';

// End-to-end test for the persistent consumed-inputs log added in issue #47.
// Uses the path-injection seams `drainIpcInputAt` and `loadConsumedInputs`
// expose so we don't need a real `/workspace/ipc` mount.

let tmp: string;
let inputDir: string;
let messagesDir: string;
let consumedLog: string;
let replyToFile: string;

function paths() {
  return {
    inputDir,
    messagesDir,
    consumedLog,
    replyToFile,
  };
}

function writeMessage(name: string, body: object): string {
  fs.mkdirSync(inputDir, { recursive: true });
  const p = path.join(inputDir, name);
  fs.writeFileSync(p, JSON.stringify(body));
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-ipc-'));
  inputDir = path.join(tmp, 'input');
  messagesDir = path.join(tmp, 'messages');
  consumedLog = path.join(messagesDir, '_consumed_inputs.log');
  replyToFile = path.join(inputDir, '_reply_to');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(messagesDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('persistent consumed-inputs log', () => {
  it('appends consumed basenames to the log on drain', () => {
    writeMessage('1-aaa.json', { type: 'message', text: 'hello' });
    writeMessage('2-bbb.json', { type: 'message', text: 'world' });

    const consumed = new Set<string>();
    const messages = drainIpcInputAt(consumed, paths());

    expect(messages).toEqual(['hello', 'world']);
    expect(consumed.has('1-aaa.json')).toBe(true);
    expect(consumed.has('2-bbb.json')).toBe(true);

    expect(fs.existsSync(consumedLog)).toBe(true);
    const log = fs.readFileSync(consumedLog, 'utf-8');
    expect(log).toContain('1-aaa.json');
    expect(log).toContain('2-bbb.json');
  });

  it('does not write to the log when no files are consumed', () => {
    const consumed = new Set<string>();
    const messages = drainIpcInputAt(consumed, paths());
    expect(messages).toEqual([]);
    expect(fs.existsSync(consumedLog)).toBe(false);
  });

  it('loadConsumedInputs replays the log into the Set', () => {
    fs.writeFileSync(consumedLog, '1-aaa.json\n2-bbb.json\n');
    const consumed = new Set<string>();

    const loaded = loadConsumedInputs(consumed, {
      consumedLog,
      messagesDir,
    });

    expect(loaded).toBe(2);
    expect(consumed.has('1-aaa.json')).toBe(true);
    expect(consumed.has('2-bbb.json')).toBe(true);
  });

  it('loadConsumedInputs tolerates a missing log (first run)', () => {
    const consumed = new Set<string>();
    const loaded = loadConsumedInputs(consumed, {
      consumedLog,
      messagesDir,
    });
    expect(loaded).toBe(0);
    expect(consumed.size).toBe(0);
  });

  it('end-to-end: a restart replays the log and skips already-consumed files', () => {
    // Simulate untrusted RO mount: write the file, drain it, but the file
    // stays on disk (because unlinkSync would normally fail with EROFS).
    // We can't easily simulate EROFS, so instead we re-create the file
    // after drain to model "the file is still there from a prior run."
    writeMessage('1-aaa.json', { type: 'message', text: 'first' });

    const consumed1 = new Set<string>();
    drainIpcInputAt(consumed1, paths());

    // Re-stage the same file (mimics the RO-mount post-restart state).
    writeMessage('1-aaa.json', { type: 'message', text: 'first' });

    // Fresh container: empty Set, replay the log first, then drain.
    const consumed2 = new Set<string>();
    loadConsumedInputs(consumed2, { consumedLog, messagesDir });
    const messages = drainIpcInputAt(consumed2, paths());

    expect(messages).toEqual([]);
    expect(consumed2.has('1-aaa.json')).toBe(true);
  });

  it('a second drain with new files only appends the new entries', () => {
    writeMessage('1-aaa.json', { type: 'message', text: 'first' });

    const consumed = new Set<string>();
    drainIpcInputAt(consumed, paths());
    const sizeAfterFirst = fs.statSync(consumedLog).size;

    // Add a new file.
    writeMessage('2-bbb.json', { type: 'message', text: 'second' });

    drainIpcInputAt(consumed, paths());
    const log = fs.readFileSync(consumedLog, 'utf-8');
    expect(log).toContain('1-aaa.json');
    expect(log).toContain('2-bbb.json');
    expect(fs.statSync(consumedLog).size).toBeGreaterThan(sizeAfterFirst);
  });
});
