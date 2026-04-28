import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { composeAutoContext } from './session-start-context.js';

let tmpRoot: string;
let memoryFile: string;
let runbookFile: string;
let dailyLogDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-context-'));
  memoryFile = path.join(tmpRoot, 'MEMORY.md');
  runbookFile = path.join(tmpRoot, 'RUNBOOK.md');
  dailyLogDir = path.join(tmpRoot, 'daily');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('composeAutoContext', () => {
  it('returns empty when no files exist', () => {
    const result = composeAutoContext({ memoryFile, runbookFile, dailyLogDir });
    expect(result.composed).toBe('');
    expect(result.sections.every((s) => !s.found)).toBe(true);
  });

  it('composes a single section when only MEMORY exists', () => {
    fs.writeFileSync(memoryFile, '- [user role](user.md) — engineer\n');
    const result = composeAutoContext({ memoryFile, runbookFile, dailyLogDir });
    expect(result.composed).toContain('section="MEMORY"');
    expect(result.composed).toContain('engineer');
    expect(result.sections.find((s) => s.label === 'MEMORY')!.found).toBe(true);
    expect(result.sections.find((s) => s.label === 'RUNBOOK')!.found).toBe(false);
  });

  it('composes all three sections when present', () => {
    fs.writeFileSync(memoryFile, 'M-CONTENT');
    fs.writeFileSync(runbookFile, 'R-CONTENT');
    fs.mkdirSync(dailyLogDir);
    fs.writeFileSync(path.join(dailyLogDir, '2026-04-27.md'), 'D-CONTENT');
    const result = composeAutoContext({ memoryFile, runbookFile, dailyLogDir });
    expect(result.composed).toContain('M-CONTENT');
    expect(result.composed).toContain('R-CONTENT');
    expect(result.composed).toContain('D-CONTENT');
    // Each section is wrapped in an <auto-context> element.
    expect((result.composed.match(/<auto-context\b/g) ?? []).length).toBe(3);
  });

  it('picks the most recent daily log file by lexical sort', () => {
    fs.mkdirSync(dailyLogDir);
    fs.writeFileSync(path.join(dailyLogDir, '2026-04-25.md'), 'OLD');
    fs.writeFileSync(path.join(dailyLogDir, '2026-04-27.md'), 'LATEST');
    fs.writeFileSync(path.join(dailyLogDir, '2026-04-26.md'), 'MID');
    const result = composeAutoContext({ memoryFile, runbookFile, dailyLogDir });
    expect(result.composed).toContain('LATEST');
    expect(result.composed).not.toContain('OLD');
    expect(result.composed).not.toContain('MID');
  });

  it('ignores non-conforming filenames in daily log dir', () => {
    fs.mkdirSync(dailyLogDir);
    fs.writeFileSync(path.join(dailyLogDir, '2026-04-27.md'), 'D');
    fs.writeFileSync(path.join(dailyLogDir, 'README.md'), 'NOPE');
    fs.writeFileSync(path.join(dailyLogDir, '2026-04-32.md'), 'INVALID-DATE');
    const result = composeAutoContext({ memoryFile, runbookFile, dailyLogDir });
    expect(result.composed).toContain('D\n');
    expect(result.composed).not.toContain('NOPE');
  });

  it('truncates content over the per-file byte cap', () => {
    const big = 'x'.repeat(1000);
    fs.writeFileSync(memoryFile, big);
    const result = composeAutoContext({
      memoryFile,
      runbookFile,
      dailyLogDir,
      perFileMaxBytes: 200,
    });
    expect(result.composed).toContain('truncated by session-start-auto-context');
    // Body inside the auto-context tags must respect the cap.
    const memSection = result.sections.find((s) => s.label === 'MEMORY')!;
    expect(Buffer.byteLength(memSection.body, 'utf-8')).toBeLessThanOrEqual(200);
  });

  it('respects a tiny cap that is smaller than the truncation marker', () => {
    fs.writeFileSync(memoryFile, 'x'.repeat(1000));
    const cap = 10;
    const result = composeAutoContext({
      memoryFile,
      runbookFile,
      dailyLogDir,
      perFileMaxBytes: cap,
    });
    const memSection = result.sections.find((s) => s.label === 'MEMORY')!;
    // Strict cap honoured — was previously violated when headroom <= 0
    // because the function returned the full TRUNCATE_MARKER unconditionally.
    expect(Buffer.byteLength(memSection.body, 'utf-8')).toBeLessThanOrEqual(cap);
  });

  it('handles empty daily log directory gracefully', () => {
    fs.mkdirSync(dailyLogDir);
    fs.writeFileSync(memoryFile, 'M');
    const result = composeAutoContext({ memoryFile, runbookFile, dailyLogDir });
    expect(result.composed).toContain('M');
    expect(result.sections.find((s) => s.label === 'DAILY')!.found).toBe(false);
  });

  it('inlines source path in the auto-context tag for traceability', () => {
    fs.writeFileSync(memoryFile, 'x');
    const result = composeAutoContext({ memoryFile, runbookFile, dailyLogDir });
    expect(result.composed).toContain(`source="${memoryFile}"`);
  });
});
